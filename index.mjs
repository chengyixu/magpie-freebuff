const PROVIDER = 'freebuff';
const BASE_URL = 'https://freebuff.com/api/v1/paid';
const SDK = '@ai-sdk/openai-compatible';
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3Ny4xOCA3Ny4xOSIgZmlsbD0iIzEwYTM3ZiI+PHBvbHlnb24gcG9pbnRzPSI3Ny4xOCAwIDc3LjE4IDE5LjMgMTkuMyAxOS4zIDE5LjMgNzcuMTkgMCA3Ny4xOSAwIDAgNzcuMTggMCIgZmlsbD0iIzIyYzU1ZSIvPjxwb2x5Z29uIHBvaW50cz0iNjMuNjIgMjQuODkgNjMuNjIgNDQuMTkgNDQuMzIgNDQuMTkgNDQuMzIgNzcuMTkgMjUuMDMgNzcuMTkgMjUuMDMgMjQuODkgNjMuNjIgMjQuODkiIGZpbGw9IiMxNmEzNGEiLz48L3N2Zz4=';

const ALLOWED_ORIGINS = new Set([
  'https://freebuff.com',
  'https://www.freebuff.com',
]);

/**
 * A Freebuff CLI/Desktop session token is a UUID. It authenticates the
 * interactive apps only: Freebuff's free tier is gated on their attested
 * client, so pointing a session token at an external agent cannot work. The
 * Developer API key is a different credential and is not a UUID.
 */
const SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_TOKEN_MESSAGE =
  'This is a Freebuff session token (CLI/Desktop sign-in), not a Developer API key. ' +
  'Freebuff gates free-tier access to its own attested clients, so a session token cannot drive an external agent. ' +
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

function buildModel(id, name, options = {}) {
  const context = options.context ?? 131072;
  const output = options.output ?? 16384;
  const isMultimodal = Boolean(options.images ?? /-(luna|sol|argon|flash|vl)/i.test(id));
  const isReasoning = Boolean(options.reasoning ?? /-(flash|pro|argon|sol|r1)/i.test(id));
  return {
    id,
    providerID: PROVIDER,
    name: name ?? id,
    api: { id, url: BASE_URL, npm: SDK },
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning: isReasoning,
      toolcall: options.toolcall !== false,
      attachment: isMultimodal,
      input: { text: true, image: isMultimodal, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants: {},
    status: 'active',
    release_date: '',
  };
}

const DEFAULT_MODELS = {
  'deepseek-v4.1-flash': buildModel('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { context: 1048576, output: 32768, reasoning: true }),
  'deepseek-v4-flash': buildModel('deepseek-v4-flash', 'DeepSeek V4 Flash', { context: 1048576, output: 32768, reasoning: true }),
  'deepseek-v4-pro': buildModel('deepseek-v4-pro', 'DeepSeek V4 Pro', { context: 1048576, output: 32768, reasoning: true }),
  'glm-5.3-flash': buildModel('glm-5.3-flash', 'GLM 5.3 Flash', { context: 1000000, output: 32768, reasoning: true }),
  'mimo-v2.6-flash': buildModel('mimo-v2.6-flash', 'MiMo v2.6 Flash', { context: 131072, output: 16384, images: true }),
  'mimo-v2.6-pro': buildModel('mimo-v2.6-pro', 'MiMo 2.6 Pro', { context: 131072, output: 16384, images: true }),
  'solar-mini4': buildModel('solar-mini4', 'Solar Mini 4', { context: 524288, output: 16384 }),
  'solar-pro4': buildModel('solar-pro4', 'Solar Pro 4', { context: 524288, output: 16384 }),
  'gpt-6-luna': buildModel('gpt-6-luna', 'GPT-6 Luna', { context: 1000000, output: 32768, reasoning: true, images: true }),
  'gpt-6.1-sol': buildModel('gpt-6.1-sol', 'GPT-6.1 Sol', { context: 1000000, output: 32768, reasoning: true, images: true }),
  'claude-sonnet-5-5': buildModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', { context: 200000, output: 8192, images: true }),
  'claude-opus-5-5': buildModel('claude-opus-5-5', 'Claude Opus 5.5', { context: 200000, output: 8192, images: true }),
  'claude-haiku-5-5': buildModel('claude-haiku-5-5', 'Claude Haiku 5.5', { context: 200000, output: 8192, images: true }),
  'gemini-3.8-flash': buildModel('gemini-3.8-flash', 'Gemini 3.8 Flash', { context: 1000000, output: 32768, images: true }),
  'gemini-4-argon': buildModel('gemini-4-argon', 'Gemini 4 Argon', { context: 1000000, output: 32768, reasoning: true, images: true }),
  'minimax-m3': buildModel('minimax-m3', 'MiniMax M3', { context: 524288, output: 32768 }),
  'qwen3.8-max': buildModel('qwen3.8-max', 'Qwen 3.8 Max', { context: 131072, output: 16384, reasoning: true, images: true }),
};

export const FreebuffAuthPlugin = async ({ client: _client } = {}) => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: 'Freebuff',
        npm: SDK,
        api: BASE_URL,
        ...was,
        models: { ...DEFAULT_MODELS, ...(was.models ?? {}) },
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
          apiKey: 'opencode-freebuff-auth', // placeholder: the real key only goes out in fetch
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
            headers.set('user-agent', 'magpie-freebuff-plugin/1.1.0');

            const response = await fetch(target, { ...init, headers, redirect: 'error' });
            if (response.status === 401) {
              if (SESSION_TOKEN.test(rawKey)) {
                return Response.json({ error: { message: SESSION_TOKEN_MESSAGE } }, { status: 401 });
              }
              const resHeaders = new Headers(response.headers);
              resHeaders.set('X-Magpie-Sign-In', 'expired');
              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: resHeaders,
              });
            }
            return response;
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
      async models(providerConfig, { auth } = {}) {
        const fallback = providerConfig?.models && Object.keys(providerConfig.models).length > 0
          ? providerConfig.models
          : DEFAULT_MODELS;

        const rawKey = typeof auth?.key === 'string' ? auth.key.trim() : '';
        if (!rawKey || SESSION_TOKEN.test(rawKey)) return fallback;

        try {
          const res = await fetch(`${BASE_URL}/models`, {
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${rawKey}`,
              'user-agent': 'magpie-freebuff-plugin/1.1.0',
            },
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
          });

          if (res.status === 401) {
            throw Object.assign(new Error('Freebuff Developer API key rejected (HTTP 401)'), { signIn: 'expired' });
          }
          if (!res.ok) return fallback;

          const json = await res.json();
          if (!Array.isArray(json?.data)) return fallback;

          const discovered = {};
          for (const row of json.data) {
            if (!row || typeof row.id !== 'string') continue;
            const modelId = row.id.trim();
            discovered[modelId] = buildModel(modelId, row.name || modelId, {
              context: row.context_length,
              output: row.max_tokens,
              reasoning: row.capabilities?.reasoning,
              toolcall: row.capabilities?.toolCalls,
              images: row.capabilities?.images,
            });
          }
          return Object.keys(discovered).length > 0 ? discovered : fallback;
        } catch (err) {
          if (err?.signIn === 'expired') throw err;
          return fallback;
        }
      },
    },
  };
};

// Not exported as a function: magpie calls every exported function as a plugin,
// so a second export of the same one would initialise the provider twice.
export const _internal = {
  PROVIDER,
  BASE_URL,
  SDK,
  ALLOWED_ORIGINS,
  SESSION_TOKEN,
  SESSION_TOKEN_MESSAGE,
  isAllowedUrl,
  buildModel,
  DEFAULT_MODELS,
};
