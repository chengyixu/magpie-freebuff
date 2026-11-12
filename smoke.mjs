// Live check of the Developer API path with a real key (spends a few tokens):
//   FREEBUFF_API_KEY=fb_... npm run smoke
// Picks one model the catalog says streams and one it says does not, and asks each for a short
// streamed reply through the plugin's own fetch, so both the pass-through and the replay run.
import { FreebuffPlugin, _internal } from './index.mjs';

const key = process.env.FREEBUFF_API_KEY?.trim();
if (!key) {
  console.error('Set FREEBUFF_API_KEY to a Freebuff Developer API key (freebuff.com/account/api).');
  process.exit(2);
}

const { data } = await (await fetch(`${_internal.BASE_URL}/models`)).json();
const pick = (streaming) => data.find((m) => m.capabilities?.streaming === streaming && m.capabilities?.chat)?.id;
const plugin = await FreebuffPlugin();
const { fetch: send } = await plugin.auth.loader(async () => ({ type: 'api', key }));

let failed = false;
for (const [streaming, model] of [[true, pick(true)], [false, pick(false)]]) {
  if (!model) continue;
  const res = await send(`${_internal.BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
  });
  const text = await res.text();
  const reply = text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '')
    .join('');
  const ok = res.ok && /text\/event-stream/.test(res.headers.get('content-type') ?? '') && reply.length > 0;
  failed ||= !ok;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${model} (catalog streaming=${streaming}) HTTP ${res.status} ${ok ? `reply=${JSON.stringify(reply)}` : text.slice(0, 200)}`);
}
process.exit(failed ? 1 : 0);
