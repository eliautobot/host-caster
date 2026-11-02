// Google API access for a user: the stored (sealed) tokens, refreshed when they expire.
import { openTokens, sealTokens } from '../auth/oauth.js';
import { GOOGLE_SCOPES, google as googleProvider } from '../auth/providers.js';
import { getIdentity } from '../auth/users.js';
import { HttpError } from '../errors.js';
import { providerFetch } from '../net/http.js';

const SERVICE_LABEL = { calendar: 'Google Calendar', gmail: 'Gmail', youtube: 'YouTube', calendarEvents: 'Google Calendar', tasks: 'Google Tasks' };
/** what the listener allows with each write scope ("Allow Host-Caster to add to your calendar first") */
const WRITE_LABEL = { calendarEvents: 'add to your calendar', tasks: 'use your Google Tasks' };
export const serviceLabel = (scope) => SERVICE_LABEL[scope] ?? 'Google';

function notConnected(scope) {
  const code = scope === 'youtube' ? 'youtube_not_connected' : 'google_not_connected';
  return new HttpError(409, code, `Sign in with Google to use ${SERVICE_LABEL[scope] ?? 'Google'}`);
}

function scopeMissing(scope) {
  if (WRITE_LABEL[scope]) return new HttpError(403, 'scope_missing', `Allow Host-Caster to ${WRITE_LABEL[scope]} first`, { service: scope });
  return new HttpError(403, 'scope_missing', `Allow Host-Caster to read ${SERVICE_LABEL[scope] ?? 'this Google service'} first`);
}

/** True when this user granted the short scope (no Google call). */
export function hasGoogleScope(app, userId, scope) {
  if (!app.config.google.enabled) return false;
  const identity = getIdentity(app.db, userId, 'google');
  return Boolean(identity?.scopes.split(' ').includes(scope));
}

function save(app, identity, tokens) {
  app.db
    .prepare('UPDATE identities SET tokens_enc = ?, updated_at = ? WHERE id = ?')
    .run(sealTokens(app, 'google', identity.subject, tokens), Date.now(), identity.id);
}

const RATE_REASONS = /^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded)$/;

/** Retry-After in ms (seconds or an HTTP date), undefined when absent. */
function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** A Google API client bound to one user and one service scope. */
export function googleClient(app, userId, scope) {
  if (!app.config.google.enabled) throw new HttpError(409, 'google_disabled', 'Google sign-in is not set up on this server');
  const identity = getIdentity(app.db, userId, 'google');
  if (!identity) throw notConnected(scope);
  if (!identity.scopes.split(' ').includes(scope)) throw scopeMissing(scope);
  let tokens = openTokens(app, identity);
  if (!tokens?.access_token) throw scopeMissing(scope);

  async function refresh() {
    if (!tokens.refresh_token) throw scopeMissing(scope);
    try {
      const next = await googleProvider.refresh(app.config, tokens.refresh_token);
      tokens = { ...tokens, ...next, refresh_token: next.refresh_token ?? tokens.refresh_token };
      save(app, identity, tokens);
    } catch (err) {
      if (err.code === 'token_revoked') throw scopeMissing(scope);
      throw err;
    }
  }

  /**
   * {method} {apiBase}{path} with a JSON body; the answer as JSON ({} when empty). Refreshes once on 401. Errors:
   * 403 scope_missing, 404 not_found, 409 upstream_conflict, 410 gone, 429 upstream_rate_limited, else 502
   * upstream_error; each carries `upstreamStatus` (and `retryAfterMs` when Google sent one). Network trouble comes
   * from providerFetch: 504 upstream_timeout, 502 upstream_unreachable.
   * @param {string} method
   * @param {string} path
   * @param {{ params?: Record<string, unknown>, body?: unknown, timeoutMs?: number }} [opts]
   */
  async function call(method, path, { params = {}, body, timeoutMs } = {}) {
    if (!tokens.expires_at || tokens.expires_at - 60_000 < Date.now()) await refresh();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
    }
    const url = `${app.config.google.apiBase}${path}${qs.size ? `?${qs}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await providerFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, timeoutMs);
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        await refresh();
        continue;
      }
      const text = await res.text().catch(() => '');
      let out = {};
      try {
        out = text ? JSON.parse(text) : {};
      } catch {
        out = {};
      }
      if (res.ok) return out;
      const reason = out?.error?.errors?.[0]?.reason ?? out?.error?.status ?? '';
      const fail = (err) => Object.assign(err, { upstreamStatus: res.status, retryAfterMs: retryAfterMs(res) });
      if (res.status === 429 || RATE_REASONS.test(String(reason))) {
        throw fail(new HttpError(429, 'upstream_rate_limited', 'Google says to slow down. Try again later.'));
      }
      if (res.status === 403 && /insufficient|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(String(reason) + JSON.stringify(out?.error ?? ''))) {
        throw fail(scopeMissing(scope));
      }
      if (res.status === 404) throw fail(new HttpError(404, 'not_found', out?.error?.message ?? 'Not found'));
      if (res.status === 409) throw fail(new HttpError(409, 'upstream_conflict', out?.error?.message ?? 'Already exists'));
      if (res.status === 410) throw fail(new HttpError(410, 'gone', out?.error?.message ?? 'Already deleted'));
      throw fail(new HttpError(502, 'upstream_error', `Google: ${out?.error?.message ?? `HTTP ${res.status}`}`));
    }
    throw scopeMissing(scope);
  }

  /** GET {apiBase}{path} as JSON; refreshes once on 401. */
  const get = (path, params = {}) => call('GET', path, { params });

  return { get, call };
}

/**
 * Which Google services this user granted: `scopes` has the short names ('calendar', 'gmail', 'youtube') followed by
 * the matching full Google scope URLs, so a caller can check either form.
 */
export function googleStatus(app, userId) {
  const identity = getIdentity(app.db, userId, 'google');
  if (!identity) return { connected: false, scopes: [] };
  const profile = JSON.parse(identity.profile || '{}');
  const short = identity.scopes.split(' ').filter(Boolean);
  const urls = short.map((s) => GOOGLE_SCOPES[s]).filter(Boolean);
  return { connected: true, email: profile.email, scopes: [...short, ...urls] };
}
