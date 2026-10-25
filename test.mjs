import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FreebuffAuthPlugin, _internal } from './index.mjs';

describe('Freebuff Magpie Provider Plugin', () => {
  it('config merges defaults without overwriting existing provider settings', async () => {
    const plugin = await FreebuffAuthPlugin();
    const config = {
      provider: {
        freebuff: {
          customOption: 'preserved',
          models: { 'custom-model': { name: 'My Custom Model' } },
        },
      },
    };

    await plugin.config(config);

    assert.equal(config.provider.freebuff.name, 'Freebuff');
    assert.equal(config.provider.freebuff.npm, '@ai-sdk/openai-compatible');
    assert.equal(config.provider.freebuff.api, 'https://freebuff.com/api/v1/paid');
    assert.equal(config.provider.freebuff.customOption, 'preserved');
    assert.ok(config.provider.freebuff.models['custom-model'], 'user models kept');
    assert.ok(config.provider.freebuff.models['deepseek-v4.1-flash'], 'defaults kept');
  });

  it('declares exactly one method: the Developer API key', async () => {
    const plugin = await FreebuffAuthPlugin();
    assert.equal(plugin.auth.provider, 'freebuff');
    assert.ok(plugin.auth.icon.startsWith('data:image/svg+xml;base64,'));
    assert.equal(plugin.auth.methods.length, 1, 'no session-token or oauth method that cannot work');

    const [method] = plugin.auth.methods;
    assert.equal(method.type, 'api');
    assert.match(method.label, /Developer API Key/);
    assert.ok(method.prompts.some((p) => p.key === 'email'), 'optional account label');
  });

  it('loader exposes only a placeholder apiKey and injects the real key in fetch', async () => {
    const plugin = await FreebuffAuthPlugin();
    const loaderResult = await plugin.auth.loader(async () => ({ type: 'api', key: 'fb_live_key_123' }));

    assert.equal(loaderResult.baseURL, 'https://freebuff.com/api/v1/paid');
    assert.equal(loaderResult.apiKey, 'opencode-freebuff-auth');
    assert.notEqual(loaderResult.apiKey, 'fb_live_key_123', 'the real secret must not ride on loader options');

    let seen = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      seen = { input, init };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const res = await loaderResult.fetch('https://freebuff.com/api/v1/paid/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 200);
      const headers = new Headers(seen.init.headers);
      assert.equal(headers.get('authorization'), 'Bearer fb_live_key_123');
      assert.equal(headers.get('user-agent'), 'magpie-freebuff-plugin/1.1.0');
      assert.equal(seen.init.redirect, 'error');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('loader refuses to send credentials to a foreign origin', async () => {
    const plugin = await FreebuffAuthPlugin();
    const loaderResult = await plugin.auth.loader(async () => ({ type: 'api', key: 'fb_live_key_123' }));

    await assert.rejects(
      () => loaderResult.fetch('https://attacker.example.com/steal', { method: 'POST' }),
      /refusing to send credentials/,
    );
  });

  it('a CLI/Desktop session token is refused locally with an actionable message', async () => {
    const sessionToken = 'fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7';
    assert.ok(_internal.SESSION_TOKEN.test(sessionToken), 'uuid shape is recognised as a session token');

    const plugin = await FreebuffAuthPlugin();
    const loaderResult = await plugin.auth.loader(async () => ({ type: 'api', key: sessionToken }));

    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    try {
      const res = await loaderResult.fetch('https://freebuff.com/api/v1/paid/chat/completions', { method: 'POST' });
      assert.equal(res.status, 401);
      assert.equal(called, false, 'no upstream request is made with a session token');
      const body = await res.json();
      assert.match(body.error.message, /Developer API key/);
      assert.match(body.error.message, /freebuff\.com\/account\/api/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('annotates a real 401 on an API key with X-Magpie-Sign-In: expired', async () => {
    const plugin = await FreebuffAuthPlugin();
    const loaderResult = await plugin.auth.loader(async () => ({ type: 'api', key: 'fb_revoked_key' }));

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 });
    try {
      const res = await loaderResult.fetch('https://freebuff.com/api/v1/paid/chat/completions', { method: 'POST' });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('X-Magpie-Sign-In'), 'expired');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('provider.models discovers the catalog and falls back on failure', async () => {
    const plugin = await FreebuffAuthPlugin();
    const auth = { type: 'api', key: 'fb_live_key_123' };

    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        assert.ok(String(url).endsWith('/models'));
        return Response.json({
          object: 'list',
          data: [
            {
              id: 'discovered-model',
              name: 'Discovered Model',
              context_length: 65536,
              max_tokens: 8192,
              capabilities: { toolCalls: true, reasoning: true },
            },
          ],
        });
      };
      const models = await plugin.provider.models({}, { auth });
      assert.equal(models['discovered-model'].name, 'Discovered Model');
      assert.equal(models['discovered-model'].limit.context, 65536);
      assert.equal(models['discovered-model'].limit.output, 8192);
      assert.equal(models['discovered-model'].capabilities.toolcall, true);
      assert.equal(models['discovered-model'].capabilities.reasoning, true);

      // A server error keeps the curated defaults rather than emptying the picker.
      globalThis.fetch = async () => new Response('boom', { status: 500 });
      const degraded = await plugin.provider.models({}, { auth });
      assert.ok(degraded['deepseek-v4.1-flash'], 'defaults still listed after a 500');

      // 401 means the credential is gone: the account must be marked, not hidden.
      globalThis.fetch = async () => new Response('nope', { status: 401 });
      await assert.rejects(() => plugin.provider.models({}, { auth }), (err) => err?.signIn === 'expired');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('provider.models never probes upstream without a usable API key', async () => {
    const plugin = await FreebuffAuthPlugin();
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    try {
      const anonymous = await plugin.provider.models({}, {});
      assert.ok(anonymous['deepseek-v4.1-flash']);
      const sessionOnly = await plugin.provider.models(
        {},
        { auth: { type: 'api', key: 'fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7' } },
      );
      assert.ok(sessionOnly['deepseek-v4.1-flash']);
      assert.equal(called, false, 'a session token must not trigger a catalog fetch');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('usage tells the operator which kind of credential is installed', async () => {
    const plugin = await FreebuffAuthPlugin();

    const anonymous = await plugin.auth.usage(async () => null);
    assert.match(anonymous.plan, /not signed in/i);

    const session = await plugin.auth.usage(async () => ({
      key: 'fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7',
    }));
    assert.match(session.plan, /Developer API key is required/i);

    const apiKey = await plugin.auth.usage(async () => ({
      key: 'fb_live_key_123',
      metadata: { email: 'wilson@example.com' },
    }));
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
    assert.equal(fns[0].name, 'FreebuffAuthPlugin');
  });
});
