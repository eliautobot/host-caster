// Finds the brain / voice provider a proxy call refers to: from the user's synced doc, or an inline config the
// client sends (never with a key: keys always come from the user's secrets via secretRef).
import { HttpError } from '../errors.js';
import { getSecret } from './secrets.js';
import { readDoc } from './sync.js';

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const BRAIN_KEYS = ['id', 'name', 'kind', 'preset', 'baseUrl', 'model', 'temperature', 'secretRef'];
const VOICE_KEYS = ['id', 'name', 'kind', 'baseUrl', 'model', 'secretRef'];

function resolve(app, userId, { collection, id, inline, keys, label }) {
  let found;
  if (inline && typeof inline === 'object') found = pick(inline, keys);
  else if (id) found = readDoc(app, userId).doc?.[collection]?.find((x) => x.id === id);
  if (!found) throw new HttpError(404, `${label}_not_found`, `That ${label} is not synced to this server yet`);
  const secretRef = found.secretRef || (found.id ? `${label}:${found.id}` : undefined);
  const apiKey = getSecret(app, userId, secretRef) ?? '';
  return { ...pick(found, keys), apiKey };
}

export const resolveBrain = (app, userId, body) =>
  resolve(app, userId, { collection: 'brains', id: body?.brainId, inline: body?.brain, keys: BRAIN_KEYS, label: 'brain' });

export const resolveVoice = (app, userId, body) =>
  resolve(app, userId, { collection: 'voices', id: body?.voiceProviderId, inline: body?.voice, keys: VOICE_KEYS, label: 'voice' });

/** "https://api.x/v1/" + "chat/completions" */
export const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

/** Readable upstream error: { error: { message } } (OpenAI/Anthropic), { detail } (FastAPI), or text. */
export function upstreamMessage(res, fallback) {
  const text = res.body.toString('utf8').slice(0, 2000);
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? j?.error ?? j?.detail?.message ?? j?.detail ?? j?.message;
    if (typeof msg === 'string' && msg) return msg.slice(0, 300);
    if (msg) return JSON.stringify(msg).slice(0, 300);
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 300) || fallback;
}

/** Upstream failures never answer 401 (that means "not signed in to Host-Caster" to the client). */
export function upstreamError(res, who) {
  const [status, code] =
    res.status === 401 || res.status === 403
      ? [400, 'upstream_auth']
      : res.status === 404
        ? [404, 'upstream_not_found']
        : res.status === 429
          ? [429, 'upstream_rate_limited']
          : [502, 'upstream_error'];
  return new HttpError(status, code, `${who}: ${upstreamMessage(res, `HTTP ${res.status}`)}`);
}
