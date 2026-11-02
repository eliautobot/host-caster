// OAuth provider specifics: Google (OIDC + incremental API scopes, offline refresh tokens) and X (OAuth 2.0 PKCE).
import { HttpError } from '../errors.js';
import { providerFetch } from '../net/http.js';

export const GOOGLE_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  youtube: 'https://www.googleapis.com/auth/youtube.readonly',
  /** add events to the listener's own calendar and answer their invitations (asked only when they turn it on) */
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  /** read and change their Google Tasks (asked only when they turn it on) */
  tasks: 'https://www.googleapis.com/auth/tasks',
};
/** lowercase short name -> the short name (parseScopeList takes "calendarevents" too) */
const SHORT_BY_LOWER = new Map(Object.keys(GOOGLE_SCOPES).map((k) => [k.toLowerCase(), k]));
const GOOGLE_BASE_SCOPES = ['openid', 'email', 'profile'];
const X_SCOPES = ['users.read', 'tweet.read'];

/**
 * Full Google scope URLs -> short names we expose ('calendar', 'gmail', 'youtube', 'calendarEvents', 'tasks'). Exact
 * URL matches only: calendar.events is calendarEvents, never calendar (read-only) and the other way round.
 */
export function shortGoogleScopes(scopeString) {
  const granted = new Set(String(scopeString ?? '').split(/\s+/));
  return Object.entries(GOOGLE_SCOPES)
    .filter(([, url]) => granted.has(url))
    .map(([name]) => name);
}

export function parseScopeList(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => SHORT_BY_LOWER.get(s.trim().toLowerCase()))
    .filter(Boolean);
}

async function tokenRequest(url, params, headers = {}) {
  const res = await providerFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const code = body.error === 'invalid_grant' ? 'token_revoked' : 'token_exchange_failed';
    throw new HttpError(res.status === 400 || res.status === 401 ? 401 : 502, code, body.error_description ?? body.error ?? 'Token exchange failed');
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    scope: body.scope ?? '',
    expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

export const google = {
  id: 'google',
  enabled: (config) => config.google.enabled,
  redirectUri: (config) => `${config.publicUrl}/auth/google/callback`,
  /** extra: short scope names; prompt consent when asking for API scopes so Google returns a refresh token */
  authUrl(config, { state, challenge, extra = [], loginHint }) {
    const scopes = [...GOOGLE_BASE_SCOPES, ...extra.map((s) => GOOGLE_SCOPES[s])];
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: this.redirectUri(config),
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: extra.length ? 'consent select_account' : 'select_account',
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `${config.google.authUrl}?${params}`;
  },
  exchange(config, { code, verifier }) {
    return tokenRequest(config.google.tokenUrl, {
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: this.redirectUri(config),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
  },
  refresh(config, refreshToken) {
    return tokenRequest(config.google.tokenUrl, {
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
  },
  async profile(config, tokens) {
    const res = await providerFetch(config.google.userinfoUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!res.ok) throw new HttpError(502, 'profile_failed', 'Could not read the Google profile');
    const p = await res.json();
    if (!p.sub) throw new HttpError(502, 'profile_failed', 'Google did not return an account id');
    return {
      subject: String(p.sub),
      name: p.name ?? p.given_name ?? '',
      // only a verified address may join an account with the same email (online edition)
      email: p.email_verified === true || p.email_verified === 'true' ? p.email?.toLowerCase() : undefined,
      avatarUrl: p.picture,
      profile: { email: p.email?.toLowerCase(), name: p.name },
    };
  },
  async revoke(config, tokens) {
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!token) return;
    await providerFetch(config.google.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  },
};

const basic = (config) => `Basic ${Buffer.from(`${encodeURIComponent(config.x.clientId)}:${encodeURIComponent(config.x.clientSecret)}`).toString('base64')}`;

export const x = {
  id: 'x',
  enabled: (config) => config.x.enabled,
  redirectUri: (config) => `${config.publicUrl}/auth/x/callback`,
  authUrl(config, { state, challenge }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.x.clientId,
      redirect_uri: this.redirectUri(config),
      scope: X_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${config.x.authUrl}?${params}`;
  },
  exchange(config, { code, verifier }) {
    return tokenRequest(
      config.x.tokenUrl,
      {
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(config),
        code_verifier: verifier,
        client_id: config.x.clientId,
      },
      { authorization: basic(config) },
    );
  },
  async profile(config, tokens) {
    const res = await providerFetch(`${config.x.apiBase}/2/users/me?user.fields=profile_image_url,name,username`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw new HttpError(502, 'profile_failed', 'Could not read the X profile');
    const { data } = await res.json();
    if (!data?.id) throw new HttpError(502, 'profile_failed', 'X did not return an account id');
    return {
      subject: String(data.id),
      name: data.name ?? data.username ?? '',
      email: undefined,
      avatarUrl: data.profile_image_url?.replace('_normal.', '_400x400.'),
      profile: { username: data.username, name: data.name },
    };
  },
  async revoke(config, tokens) {
    if (!tokens?.access_token) return;
    await providerFetch(config.x.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(config) },
      body: new URLSearchParams({ token: tokens.access_token, token_type_hint: 'access_token' }).toString(),
    }).catch(() => undefined);
  },
};

export const PROVIDERS = { google, x };
