// Notion's OAuth (public connection, Basic auth with the server owner's client id + secret) and a per-user API client
// with the sealed tokens, refreshed once on 401 when Notion gave a refresh token.
import { HttpError } from '../../errors.js';
import { providerFetch } from '../../net/http.js';
import { getLink, saveTokens } from './store.js';

/** Notion ids are UUIDs, with or without dashes. Anything else never goes into an API path. */
export const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function checkId(id) {
  const v = String(id ?? '').trim();
  if (!NOTION_ID.test(v)) throw new HttpError(400, 'invalid_request', 'Not a Notion page id');
  return v.replace(/-/g, '').toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export const redirectUri = (config) => `${config.publicUrl}/auth/notion/callback`;

export function authorizeUrl(config, state) {
  const q = new URLSearchParams({
    client_id: config.notion.clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirectUri(config),
    state,
  });
  return `${config.notion.authUrl}?${q}`;
}

const basic = (config) => `Basic ${Buffer.from(`${config.notion.clientId}:${config.notion.clientSecret}`).toString('base64')}`;

async function oauthPost(config, path, body) {
  const res = await providerFetch(`${config.notion.apiBase}${path}`, {
    method: 'POST',
    headers: {
      authorization: basic(config),
      'content-type': 'application/json',
      accept: 'application/json',
      'notion-version': config.notion.version,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

/** Tokens as we keep them (sealed): the access token, the refresh token when Notion sends one, when they were issued. */
function tokensOf(json) {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? undefined,
    ...(json.expires_in ? { expires_at: Date.now() + Number(json.expires_in) * 1000 } : {}),
  };
}

/** code -> tokens + the workspace it was granted in. */
export async function exchangeCode(config, code) {
  const { res, json } = await oauthPost(config, '/v1/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri(config) });
  if (!res.ok || !json.access_token) {
    throw new HttpError(502, json.error === 'invalid_grant' ? 'token_revoked' : 'token_exchange_failed', 'Notion did not accept the sign-in');
  }
  return {
    tokens: tokensOf(json),
    botId: String(json.bot_id ?? ''),
    workspace: {
      id: json.workspace_id ?? null,
      name: typeof json.workspace_name === 'string' ? json.workspace_name.slice(0, 120) : null,
      icon: typeof json.workspace_icon === 'string' ? json.workspace_icon.slice(0, 500) : null,
    },
  };
}

export async function refreshTokens(config, refreshToken) {
  const { res, json } = await oauthPost(config, '/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!res.ok || !json.access_token) throw notionGone();
  return tokensOf(json);
}

/** Best effort: Notion forgets the access (the user can also remove Host-Caster in Notion's Settings, Connections). */
export async function revokeToken(config, tokens) {
  if (!tokens?.access_token) return;
  await oauthPost(config, '/v1/oauth/revoke', { token: tokens.access_token }).catch(() => undefined);
}

export const notionGone = () => new HttpError(409, 'notion_disconnected', 'Notion no longer lets Host-Caster in. Connect it again.');
export const notConnected = () => new HttpError(409, 'notion_not_connected', 'Connect Notion first');

/** API client for one user. Throws notion_not_connected when there is no link. */
export function notionClient(app, userId) {
  const link = getLink(app, userId);
  if (!link) throw notConnected();
  let tokens = link.tokens;
  if (!tokens?.access_token) throw notionGone();
  const { config } = app;

  async function refresh() {
    if (!tokens.refresh_token) throw notionGone();
    tokens = { ...tokens, ...(await refreshTokens(config, tokens.refresh_token)) };
    saveTokens(app, userId, tokens);
  }

  /** One JSON call; refreshes once on 401. */
  async function call(method, path, body) {
    if (tokens.expires_at && tokens.expires_at - 60_000 < Date.now() && tokens.refresh_token) await refresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await providerFetch(`${config.notion.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'notion-version': config.notion.version,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      if (res.status === 401 && attempt === 0 && tokens.refresh_token) {
        await refresh();
        continue;
      }
      if (res.status === 401) throw notionGone();
      if (res.status === 404 || json.code === 'object_not_found') {
        throw new HttpError(404, 'notion_not_shared', 'Host-Caster cannot see that page. Share it with Host-Caster in Notion.');
      }
      if (res.status === 403) throw new HttpError(403, 'notion_no_access', 'Notion did not allow that. Check what Host-Caster may do in Notion.');
      if (res.status === 429) throw new HttpError(429, 'upstream_rate_limited', 'Notion says to slow down. Try again in a minute.');
      if (res.status === 400) throw new HttpError(400, 'notion_refused', `Notion: ${String(json.message ?? 'the request was refused').slice(0, 200)}`);
      throw new HttpError(502, 'upstream_error', `Notion answered ${res.status}`);
    }
    throw notionGone();
  }

  return { link, call };
}
