import { readFileSync } from 'node:fs';

const PROVIDER = 'freebuff';
const BASE_URL = 'https://freebuff.com/api/v1/paid';
const SDK = '@ai-sdk/openai-compatible';
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3Ny4xOCA3Ny4xOSIgZmlsbD0iIzEwYTM3ZiI+PHBvbHlnb24gcG9pbnRzPSI3Ny4xOCAwIDc3LjE4IDE5LjMgMTkuMyAxOS4zIDE5LjMgNzcuMTkgMCA3Ny4xOSAwIDAgNzcuMTggMCIgZmlsbD0iIzIyYzU1ZSIvPjxwb2x5Z29uIHBvaW50cz0iNjMuNjIgMjQuODkgNjMuNjIgNDQuMTkgNDQuMzIgNDQuMTkgNDQuMzIgNzcuMTkgMjUuMDMgNzcuMTkgMjUuMDMgMjQuODkgNjMuNjIgMjQuODkiIGZpbGw9IiMxNmEzNGEiLz48L3N2Zz4=';
const API_KEY_PLACEHOLDER = 'magpie-freebuff';
const USER_AGENT = `magpie-freebuff/${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version}`;
const CATALOG_TTL_MS = 10 * 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  'https://freebuff.com',
  'https://www.freebuff.com',
]);

/**
 * A Freebuff CLI/Desktop session token is a UUID. It signs in Freebuff's own interactive apps,
 * and Freebuff offers no supported way for another program to spend that free tier. The
 * Developer API key is a different credential and is not a UUID.
 */
const SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_TOKEN_MESSAGE =
  'This is a Freebuff session token (CLI/Desktop sign-in), not a Developer API key. ' +
  'Freebuff has no supported way for another program to use that free tier. ' +
  'Create a Developer API key at https://freebuff.com/account/api and sign in again.';

function isAllowedUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (ALLOWED_ORIGINS.has(url.origin)) return true;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * The live model list. GET /models is public (it answers the same with or without a key), so it
 * is the one source of models: nothing here may be copied into the plugin. Reads are cached; a
 * failed refresh serves the last good list, and with none it throws so the host keeps its own.
 */
function createCatalog() {
  let rows = null;
  let loadedAt = 0;
  let inflight = null;

  async function load() {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Freebuff catalog request failed (HTTP ${res.status})`);
    const json = await res.json().catch(() => {
      throw new Error('Freebuff catalog response is not JSON');
    });
    if (!Array.isArray(json?.data)) throw new Error('Freebuff catalog response has no model list');
    return json.data
      .filter((row) => typeof row?.id === 'string' && row.id.trim())
      .map((row) => ({
        id: row.id.trim(),
        toolCalls: row.capabilities?.toolCalls === true,
        streaming: row.capabilities?.streaming === true,
      }));
  }

  return async function catalog() {
    if (rows && Date.now() - loadedAt < CATALOG_TTL_MS) return rows;
    inflight ??= load()
      .then((loaded) => {
        rows = loaded;
        loadedAt = Date.now();
        return loaded;
      })
      .finally(() => {
        inflight = null;
      });
    try {
      return await inflight;
    } catch (err) {
      if (rows) return rows;
      throw err;
    }
  };
}

function toModel(row) {
  return {
    id: row.id,
    providerID: PROVIDER,
    name: row.id,
    api: { id: row.id, url: BASE_URL, npm: SDK },
    // The catalog states tool-call support only. It publishes no limits, modalities or
    // reasoning support, so none is claimed; a user can set them per model in the provider config.
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: row.toolCalls,
      attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants: {},
    status: 'active',
    release_date: '',
  };
}

/**
 * A model the catalog says cannot stream gets one JSON reply from upstream, which `toEventStream`
 * replays to the streaming client. Returns the rewritten body, or null to forward the request
 * as it is (not streaming, a model that streams, or no catalog to say).
 */
async function withoutStreaming(body, catalog) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return null;
  }
  if (request?.stream !== true) return null;
  const rows = await catalog().catch(() => null);
  const row = rows?.find((r) => r.id === request.model);
  if (!row || row.streaming) return null;
  const { stream_options: _dropped, ...rest } = request;
  return JSON.stringify({ ...rest, stream: false });
}

async function toEventStream(response) {
  const text = await response.text();
  let completion = null;
  try {
    completion = JSON.parse(text);
  } catch {
    // handled below
  }
  if (!Array.isArray(completion?.choices)) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  }

  const chunks = [];
  for (const choice of completion.choices) {
    const index = choice.index ?? 0;
    const message = choice.message ?? {};
    const delta = { role: 'assistant' };
    if (message.content) delta.content = message.content;
    if (message.reasoning_content) delta.reasoning_content = message.reasoning_content;
    if (message.tool_calls?.length) {
      delta.tool_calls = message.tool_calls.map((call, i) => ({
        index: i,
        id: call.id,
        type: 'function',
        function: { name: call.function?.name, arguments: call.function?.arguments ?? '' },
      }));
    }
    chunks.push({ choices: [{ index, delta, finish_reason: null }] });
    chunks.push({ choices: [{ index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
  }
  if (completion.usage) chunks.at(-1).usage = completion.usage;

  const events = chunks.map((chunk) =>
    `data: ${JSON.stringify({
      id: completion.id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model: completion.model,
      ...chunk,
    })}\n\n`,
  );
  return new Response(events.join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

export const FreebuffPlugin = async () => {
  const catalog = createCatalog();

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: 'Freebuff',
        npm: SDK,
        api: BASE_URL,
        ...was,
        models: was.models ?? {},
      };
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 4,
      icon: ICON,
      methods: [
        {
          type: 'api',
          label: 'Freebuff Developer API Key (freebuff.com/account/api)',
          placeholder: 'fb_...',
          prompts: [
            {
              key: 'email',
              type: 'text',
              label: 'Account Label (optional, for several keys)',
              placeholder: 'e.g. personal, work',
            },
          ],
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        const rawKey = typeof auth?.key === 'string' ? auth.key.trim() : '';
        if (!rawKey) return {};

        return {
          baseURL: BASE_URL,
          apiKey: API_KEY_PLACEHOLDER, // placeholder: the real key only goes out in fetch
          async fetch(input, init) {
            const target = String(input);
            if (!isAllowedUrl(target)) {
              throw new Error(`${PROVIDER}: refusing to send credentials to ${new URL(target).origin}`);
            }
            if (SESSION_TOKEN.test(rawKey)) {
              return Response.json({ error: { message: SESSION_TOKEN_MESSAGE } }, { status: 401 });
            }

            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${rawKey}`);
            headers.set('user-agent', USER_AGENT);

            const rewritten = typeof init?.body === 'string' ? await withoutStreaming(init.body, catalog) : null;
            const response = await fetch(target, {
              ...init,
              ...(rewritten ? { body: rewritten } : {}),
              headers,
              redirect: 'error',
            });

            if (response.status === 401) {
              const resHeaders = new Headers(response.headers);
              resHeaders.set('X-Magpie-Sign-In', 'expired');
              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: resHeaders,
              });
            }
            return rewritten && response.ok ? toEventStream(response) : response;
          },
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth?.key) return { plan: 'Freebuff (not signed in)', windows: [] };
        if (SESSION_TOKEN.test(String(auth.key).trim())) {
          return { plan: 'Freebuff: session token — a Developer API key is required', windows: [] };
        }
        const label = auth.metadata?.email ? ` (${auth.metadata.email})` : '';
        return { plan: `Freebuff Developer API${label} · usage billed to your Freebuff credits`, windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(providerConfig) {
        const configured = providerConfig?.models ?? {};
        const models = {};
        for (const row of await catalog()) {
          const model = toModel(row);
          models[row.id] = { ...model, ...(configured[row.id] ?? {}), id: model.id, providerID: PROVIDER, api: model.api };
        }
        return models;
      },
    },
  };
};

// Not exported as a function: magpie calls every exported function as a plugin,
// so a second export of the same one would initialise the provider twice.
export const _internal = { BASE_URL, SESSION_TOKEN };
