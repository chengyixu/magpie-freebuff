import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { FreebuffPlugin, _internal } from './index.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// A recorded slice of the real GET /api/v1/paid/models response. Re-record it with curl when
// the catalog's shape changes; never hand-write rows here.
const CATALOG = JSON.parse(readFileSync(new URL('./fixtures/paid-models.json', import.meta.url), 'utf8'));

const KEY = 'fb_live_key_123';
const SESSION_TOKEN = 'fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7';
const CHAT_URL = `${_internal.BASE_URL}/chat/completions`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace global fetch: the catalog URL answers with `catalog`, anything else goes to `onChat`. */
function stubFetch({ catalog = () => Response.json(CATALOG), onChat = () => Response.json({}) } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return call.url.endsWith('/models') ? catalog(call) : onChat(call);
  };
  return calls;
}

async function signedInFetch(plugin = null) {
  const p = plugin ?? (await FreebuffPlugin());
  const loaded = await p.auth.loader(async () => ({ type: 'api', key: KEY }));
  return loaded.fetch;
}

const chatBody = (model, extra = {}) =>
  JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });

/** Parse an SSE body back into the message a client would assemble from it. */
async function assembleSse(res) {
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean);
  assert.equal(events.at(-1), 'data: [DONE]', 'stream ends with [DONE]');
  const message = { content: '', reasoning: '', toolCalls: [], finish: null, usage: null };
  for (const event of events.slice(0, -1)) {
    assert.ok(event.startsWith('data: '), `SSE event framing: ${event.slice(0, 20)}`);
    const chunk = JSON.parse(event.slice('data: '.length));
    assert.equal(chunk.object, 'chat.completion.chunk');
    if (chunk.usage) message.usage = chunk.usage;
    for (const choice of chunk.choices) {
      const delta = choice.delta ?? {};
      message.content += delta.content ?? '';
      message.reasoning += delta.reasoning_content ?? '';
      for (const tc of delta.tool_calls ?? []) {
        const slot = (message.toolCalls[tc.index] ??= { id: '', name: '', args: '' });
        slot.id ||= tc.id ?? '';
        slot.name += tc.function?.name ?? '';
        slot.args += tc.function?.arguments ?? '';
      }
      if (choice.finish_reason) message.finish = choice.finish_reason;
    }
  }
  return message;
}

describe('catalog: the live GET /models is the only source of models', () => {
  it('config seeds the provider shell, keeps the user settings, and bakes in no model list', async () => {
    const plugin = await FreebuffPlugin();
    const config = {
      provider: {
        freebuff: { customOption: 'preserved', models: { 'custom-model': { name: 'My Custom Model' } } },
      },
    };
    await plugin.config(config);

    const freebuff = config.provider.freebuff;
    assert.equal(freebuff.name, 'Freebuff');
    assert.equal(freebuff.npm, '@ai-sdk/openai-compatible');
    assert.equal(freebuff.api, 'https://freebuff.com/api/v1/paid');
    assert.equal(freebuff.customOption, 'preserved');
    assert.deepEqual(Object.keys(freebuff.models), ['custom-model'], 'a second copy of the catalog would drift');

    const empty = { provider: {} };
    await plugin.config(empty);
    assert.deepEqual(empty.provider.freebuff.models, {});
  });

  it('maps every catalog row and reports only the capabilities the catalog states', async () => {
    stubFetch();
    const plugin = await FreebuffPlugin();
    const models = await plugin.provider.models({}, {});

    assert.deepEqual(Object.keys(models).sort(), CATALOG.data.map((r) => r.id).sort());
    for (const row of CATALOG.data) {
      const model = models[row.id];
      assert.equal(model.id, row.id);
      assert.equal(model.providerID, 'freebuff');
      assert.deepEqual(model.api, { id: row.id, url: _internal.BASE_URL, npm: '@ai-sdk/openai-compatible' });
      assert.equal(model.capabilities.toolcall, row.capabilities.toolCalls, `${row.id} toolcall`);
      // The catalog says nothing about images, reasoning or limits: claim none of them.
      assert.equal(model.capabilities.attachment, false, `${row.id} attachment`);
      assert.equal(model.capabilities.input.image, false, `${row.id} image input`);
      assert.equal(model.capabilities.reasoning, false, `${row.id} reasoning`);
      assert.deepEqual(model.limit, { context: 0, output: 0 }, `${row.id} limit`);
    }
    // Real rows that the old hardcoded list got wrong.
    assert.equal(models['claude-opus-5-5'].capabilities.toolcall, false);
    assert.equal(models['deepseek-v4.1-flash'].capabilities.toolcall, true);
  });

  it('asks the public catalog without credentials, even when signed in', async () => {
    const calls = stubFetch();
    const plugin = await FreebuffPlugin();
    await plugin.provider.models({}, { auth: { type: 'api', key: KEY } });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/models'));
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), null, 'the key never leaves for a public endpoint');
  });

  it('user overrides win for a listed model, and a model the catalog lacks is not invented', async () => {
    stubFetch();
    const plugin = await FreebuffPlugin();
    const models = await plugin.provider.models(
      { models: { 'claude-opus-5-5': { limit: { context: 200000, output: 8192 } }, 'custom-model': { name: 'x' } } },
      {},
    );
    assert.deepEqual(models['claude-opus-5-5'].limit, { context: 200000, output: 8192 });
    assert.equal(models['claude-opus-5-5'].api.id, 'claude-opus-5-5', 'the wire id stays the catalog id');
    assert.equal(models['custom-model'], undefined);
  });

  it('caches the catalog, and throws when it cannot be had so the host keeps its list', async () => {
    const calls = stubFetch();
    const plugin = await FreebuffPlugin();
    await plugin.provider.models({}, {});
    await plugin.provider.models({}, {});
    assert.equal(calls.length, 1, 'second read is served from the cache');

    for (const bad of [() => new Response('boom', { status: 500 }), () => Response.json({ data: 'nope' })]) {
      stubFetch({ catalog: bad });
      const fresh = await FreebuffPlugin();
      await assert.rejects(() => fresh.provider.models({}, {}), /catalog/i);
    }
  });
});

describe('streaming: models the catalog says do not stream still work for streaming clients', () => {
  const upstreamCompletion = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-6-luna',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello there',
          reasoning_content: 'thinking',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };

  it('asks upstream for one JSON reply and replays it as an SSE stream', async () => {
    const calls = stubFetch({ onChat: () => Response.json(upstreamCompletion) });
    const fetchChat = await signedInFetch();
    const res = await fetchChat(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody('gpt-6-luna', { stream: true, stream_options: { include_usage: true } }),
    });

    const sent = JSON.parse(calls.find((c) => c.url === CHAT_URL).init.body);
    assert.equal(sent.stream, false);
    assert.equal(sent.stream_options, undefined, 'stream_options is only valid with stream:true');
    assert.equal(sent.model, 'gpt-6-luna');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const message = await assembleSse(res);
    assert.equal(message.content, 'Hello there');
    assert.equal(message.reasoning, 'thinking');
    assert.deepEqual(message.toolCalls, [{ id: 'call_1', name: 'read', args: '{"path":"a"}' }]);
    assert.equal(message.finish, 'tool_calls');
    assert.deepEqual(message.usage, upstreamCompletion.usage);
  });

  it('forwards the request untouched for a model that streams', async () => {
    const calls = stubFetch({ onChat: () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    const fetchChat = await signedInFetch();
    const body = chatBody('deepseek-v4.1-flash', { stream: true });
    await fetchChat(CHAT_URL, { method: 'POST', body });
    assert.equal(calls.find((c) => c.url === CHAT_URL).init.body, body);
  });

  it('forwards the request untouched when the client did not ask to stream', async () => {
    const calls = stubFetch({ onChat: () => Response.json(upstreamCompletion) });
    const fetchChat = await signedInFetch();
    const body = chatBody('gpt-6-luna', { stream: false });
    const res = await fetchChat(CHAT_URL, { method: 'POST', body });
    assert.equal(calls.find((c) => c.url === CHAT_URL).init.body, body);
    assert.equal((await res.json()).object, 'chat.completion');
  });

  it('passes an upstream error through unchanged', async () => {
    stubFetch({ onChat: () => Response.json({ error: { message: 'Insufficient credits' } }, { status: 402 }) });
    const fetchChat = await signedInFetch();
    const res = await fetchChat(CHAT_URL, { method: 'POST', body: chatBody('gpt-6-luna', { stream: true }) });
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { error: { message: 'Insufficient credits' } });
  });

  it('does not block a chat when the catalog is unreachable', async () => {
    const calls = stubFetch({
      catalog: () => new Response('down', { status: 503 }),
      onChat: () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    });
    const fetchChat = await signedInFetch();
    const body = chatBody('gpt-6-luna', { stream: true });
    const res = await fetchChat(CHAT_URL, { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.equal(calls.find((c) => c.url === CHAT_URL).init.body, body);
  });
});

describe('credentials: a Developer API key, injected per request', () => {
  it('declares exactly one method: the Developer API key', async () => {
    const plugin = await FreebuffPlugin();
    assert.equal(plugin.auth.provider, 'freebuff');
    assert.ok(plugin.auth.icon.startsWith('data:image/svg+xml;base64,'));
    assert.equal(plugin.auth.methods.length, 1, 'no session-token or oauth method that cannot work');
    const [method] = plugin.auth.methods;
    assert.equal(method.type, 'api');
    assert.match(method.label, /Developer API Key/);
    assert.ok(method.prompts.some((p) => p.key === 'email'), 'optional account label');
  });

  it('loader exposes only a placeholder apiKey and injects the real key in fetch', async () => {
    const plugin = await FreebuffPlugin();
    const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: KEY }));
    assert.equal(loaded.baseURL, 'https://freebuff.com/api/v1/paid');
    assert.equal(loaded.apiKey, 'magpie-freebuff');
    assert.notEqual(loaded.apiKey, KEY, 'the real secret must not ride on loader options');

    const calls = stubFetch({ onChat: () => Response.json({ ok: true }) });
    const res = await loaded.fetch(CHAT_URL, { method: 'POST', body: chatBody('deepseek-v4.1-flash') });
    assert.equal(res.status, 200);
    const sent = calls.find((c) => c.url === CHAT_URL).init;
    const headers = new Headers(sent.headers);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(headers.get('user-agent'), `magpie-freebuff/${pkg.version}`, 'one version, from package.json');
    assert.equal(sent.redirect, 'error');
  });

  it('loader refuses to send credentials to a foreign origin', async () => {
    const fetchChat = await signedInFetch();
    await assert.rejects(
      () => fetchChat('https://attacker.example.com/steal', { method: 'POST' }),
      /refusing to send credentials/,
    );
  });

  it('a CLI/Desktop session token is refused locally with an actionable message', async () => {
    assert.ok(_internal.SESSION_TOKEN.test(SESSION_TOKEN), 'uuid shape is recognised as a session token');
    const plugin = await FreebuffPlugin();
    const loaded = await plugin.auth.loader(async () => ({ type: 'api', key: SESSION_TOKEN }));
    const calls = stubFetch();
    const res = await loaded.fetch(CHAT_URL, { method: 'POST', body: chatBody('deepseek-v4.1-flash') });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, 'no upstream request is made with a session token');
    const { error } = await res.json();
    assert.match(error.message, /Developer API key/);
    assert.match(error.message, /freebuff\.com\/account\/api/);
  });

  it('annotates a real 401 on an API key with X-Magpie-Sign-In: expired', async () => {
    stubFetch({ onChat: () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }) });
    const fetchChat = await signedInFetch();
    const res = await fetchChat(CHAT_URL, { method: 'POST', body: chatBody('deepseek-v4.1-flash') });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('X-Magpie-Sign-In'), 'expired');
  });

  it('usage tells the operator which kind of credential is installed', async () => {
    const plugin = await FreebuffPlugin();
    assert.match((await plugin.auth.usage(async () => null)).plan, /not signed in/i);
    assert.match((await plugin.auth.usage(async () => ({ key: SESSION_TOKEN }))).plan, /Developer API key is required/i);
    const apiKey = await plugin.auth.usage(async () => ({ key: KEY, metadata: { email: 'wilson@example.com' } }));
    assert.match(apiKey.plan, /Developer API/);
    assert.match(apiKey.plan, /wilson@example\.com/);
    assert.deepEqual(apiKey.windows, []);
  });
});

describe('plugin entry contract', () => {
  it('exports exactly one function, because magpie calls every exported function', async () => {
    const mod = await import('./index.mjs');
    const fns = Object.values(mod).filter((v) => typeof v === 'function');
    assert.equal(fns.length, 1, 'a second exported function would initialise the provider twice');
    assert.equal(fns[0].name, 'FreebuffPlugin');
  });
});
