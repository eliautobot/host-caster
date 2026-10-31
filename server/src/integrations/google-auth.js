// Google API access for a user: the stored (sealed) tokens, refreshed when they expire.
import { openTokens, sealTokens } from '../auth/oauth.js';
import { GOOGLE_SCOPES, google as googleProvider } from '../auth/providers.js';
import { getIdentity } from '../auth/users.js';
import { HttpError } from '../errors.js';
import { providerFetch } from '../net/http.js';

const SERVICE_LABEL = { calendar: 'Google Calendar', gmail: 'Gmail', youtube: 'YouTube' };

function notConnected(scope) {
  const code = scope === 'youtube' ? 'youtube_not_connected' : 'google_not_connected';
  return new HttpError(409, code, `Sign in with Google to use ${SERVICE_LABEL[scope] ?? 'Google'}`);
}

function scopeMissing(scope) {
  return new HttpError(403, 'scope_missing', `Allow Host-Caster to read ${SERVICE_LABEL[scope] ?? 'this Google service'} first`);
}

function save(app, identity, tokens) {
  app.db
    .prepare('UPDATE identities SET tokens_enc = ?, updated_at = ? WHERE id = ?')
    .run(sealTokens(app, 'google', identity.subject, tokens), Date.now(), identity.id);
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

  /** GET {apiBase}{path} as JSON; refreshes once on 401. */
  async function get(path, params = {}) {
    if (!tokens.expires_at || tokens.expires_at - 60_000 < Date.now()) await refresh();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
    }
    const url = `${app.config.google.apiBase}${path}${qs.size ? `?${qs}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await providerFetch(url, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' } });
      if (res.status === 401 && attempt === 0) {
        await refresh();
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
      if (res.status === 403 && /insufficient|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(String(reason) + JSON.stringify(body?.error ?? ''))) {
        throw scopeMissing(scope);
      }
      if (res.status === 404) throw new HttpError(404, 'not_found', body?.error?.message ?? 'Not found');
      if (res.status === 429 || reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
        throw new HttpError(429, 'upstream_rate_limited', 'Google says to slow down. Try again later.');
      }
      throw new HttpError(502, 'upstream_error', `Google: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    }
    throw scopeMissing(scope);
  }

  return { get };
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
