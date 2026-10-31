// Spotify sign-in (PKCE, no server) + token storage/refresh. The user brings their own Spotify app Client ID
// (Settings > Music services), or the server offers one in /api/config `spotifyClientId`.
// kv 'spotify:tokens' = tokens (device only); kv 'spotify:pending' = the in-flight login (verifier + state).
import { api } from '../../api';
import { getSettings, kvDelete, kvGet, kvSet, saveSettings } from '../../db';
import { isNative, onDeepLink, openAuthUrl } from '../../native';
import {
  SPOTIFY_TOKEN_URL,
  buildAuthorizeUrl,
  challengeFor,
  codeExchangeBody,
  randomState,
  randomVerifier,
  redirectUriProblem,
  refreshBody,
} from './pkce';
import { SPOTIFY_CALLBACK_ROUTE } from './redirect';

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  scope: string;
  clientId: string;
}

interface PendingLogin {
  verifier: string;
  state: string;
  redirectUri: string;
  clientId: string;
  startedAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
}

const TOKENS_KEY = 'spotify:tokens';
const PENDING_KEY = 'spotify:pending';
const PENDING_TTL = 15 * 60_000;
/** refresh this long before expiry */
const SKEW_MS = 60_000;

export class SpotifyAuthError extends Error {
  override name = 'SpotifyAuthError';
  constructor(
    message: string,
    readonly code: 'not_connected' | 'no_client_id' | 'denied' | 'state_mismatch' | 'expired' | 'exchange_failed' = 'not_connected',
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (u, i) => fetch(u, i);

/** Tests swap the network here (shared by the Web API client). */
export function setSpotifyFetch(fn: FetchLike | undefined): void {
  fetchImpl = fn ?? ((u, i) => fetch(u, i));
  memo = undefined;
}

export function spotifyFetchImpl(): FetchLike {
  return fetchImpl;
}

/** App base path ('/' unless the app is served from a sub folder). */
function appBase(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return base.startsWith('/') ? base : '/';
}

/** The redirect URI to register in the Spotify developer dashboard for this install. */
export function spotifyRedirectUri(): string {
  if (isNative) return `${api.config?.appScheme ?? 'hostcaster'}://spotify`;
  if (typeof location === 'undefined') return 'http://127.0.0.1/spotify/callback';
  return `${location.origin}${appBase().replace(/\/$/, '')}/spotify/callback`;
}

/** Problem with this page's redirect URI for Spotify (http non-loopback, localhost), if any. */
export function spotifyRedirectProblem(): string | undefined {
  return redirectUriProblem(spotifyRedirectUri());
}

export async function spotifyClientId(): Promise<string | undefined> {
  const settings = await getSettings();
  const own = settings.connections.spotify?.clientId?.trim();
  if (own) return own;
  const fromServer = (api.config as { spotifyClientId?: string } | undefined)?.spotifyClientId?.trim();
  return fromServer || undefined;
}

export async function setSpotifyClientId(clientId: string): Promise<void> {
  const id = clientId.trim();
  if (id && !/^[0-9a-f]{32}$/i.test(id)) throw new Error('A Spotify Client ID is 32 letters and numbers (0-9, a-f).');
  const settings = await getSettings();
  const prev = settings.connections.spotify ?? { connected: false };
  await saveSettings({ connections: { ...settings.connections, spotify: { ...prev, clientId: id || undefined } } });
}

/** Starts the login: saves verifier + state, then opens Spotify (same tab on web, system browser on native). */
export async function beginSpotifyLogin(opts: { showDialog?: boolean } = {}): Promise<void> {
  const clientId = await spotifyClientId();
  if (!clientId) throw new SpotifyAuthError('Add your Spotify Client ID first.', 'no_client_id');
  const redirectUri = spotifyRedirectUri();
  const problem = redirectUriProblem(redirectUri);
  if (problem) throw new SpotifyAuthError(problem, 'exchange_failed');
  const verifier = randomVerifier();
  const state = randomState();
  await kvSet<PendingLogin>(PENDING_KEY, { verifier, state, redirectUri, clientId, startedAt: Date.now() });
  if (isNative) listenForNativeRedirect();
  await openAuthUrl(buildAuthorizeUrl({ clientId, redirectUri, challenge: await challengeFor(verifier), state, showDialog: opts.showDialog }));
}

/** `hostcaster://spotify?code=..&state=..` (any scheme) -> its query, or undefined for other links. */
export function parseSpotifyDeepLink(url: string): { code?: string; state?: string; error?: string } | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\/spotify(?:[/?#]|$)/i.test(url)) return undefined;
  const q = new URL(url.replace(/^[a-z][a-z0-9+.-]*:\/\/spotify\/?/i, 'https://x/')).searchParams;
  const out: { code?: string; state?: string; error?: string } = {};
  for (const k of ['code', 'state', 'error'] as const) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return out;
}

let nativeListening = false;
function listenForNativeRedirect(): void {
  if (nativeListening) return;
  nativeListening = true;
  onDeepLink((url) => {
    const params = parseSpotifyDeepLink(url);
    if (!params) return;
    // the sign-in tab can stay open over the app (iOS): close it
    void import('@capacitor/browser').then((m) => m.Browser.close()).catch(() => undefined);
    // the callback screen finishes the sign-in and shows progress / errors, same as on the web
    const q = new URLSearchParams(params).toString();
    if (typeof location !== 'undefined') location.hash = `${SPOTIFY_CALLBACK_ROUTE}?${q}`;
    else void completeSpotifyLogin(params).catch((err: unknown) => console.warn('[hostcaster] spotify', err));
  });
}

/** Native: call once at boot so a cold-start deep link finishes the login. */
export function initSpotifyNative(): void {
  if (isNative) listenForNativeRedirect();
}

/** Finishes the login from the redirect query (code + state, or error). */
export async function completeSpotifyLogin(params: { code?: string; state?: string; error?: string }): Promise<SpotifyTokens> {
  const pending = (await kvGet<PendingLogin>(PENDING_KEY))?.value;
  if (params.error) {
    await kvDelete(PENDING_KEY);
    throw new SpotifyAuthError(
      params.error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify said: ${params.error}`,
      'denied',
    );
  }
  if (!pending || Date.now() - pending.startedAt > PENDING_TTL) {
    throw new SpotifyAuthError('This Spotify sign-in expired. Please try again.', 'expired');
  }
  if (!params.state || params.state !== pending.state) {
    throw new SpotifyAuthError('Spotify sign-in did not match this device. Please try again.', 'state_mismatch');
  }
  if (!params.code) throw new SpotifyAuthError('Spotify did not send a sign-in code.', 'exchange_failed');
  const res = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: codeExchangeBody({ clientId: pending.clientId, code: params.code, redirectUri: pending.redirectUri, verifier: pending.verifier }),
  });
  await kvDelete(PENDING_KEY);
  if (!res.ok) throw new SpotifyAuthError(await tokenError(res), 'exchange_failed');
  const body = (await res.json()) as TokenResponse;
  if (!body.refresh_token) throw new SpotifyAuthError('Spotify did not return a refresh token.', 'exchange_failed');
  const tokens = toTokens(body, pending.clientId, body.refresh_token);
  await kvSet(TOKENS_KEY, tokens);
  memo = tokens;
  const settings = await getSettings();
  const prev = settings.connections.spotify;
  await saveSettings({
    connections: { ...settings.connections, spotify: { ...prev, connected: true, clientId: prev?.clientId ?? pending.clientId } },
  });
  return tokens;
}

async function tokenError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; error_description?: string };
    if (j.error === 'invalid_client') return 'Spotify does not know this Client ID.';
    if (j.error_description?.includes('redirect')) return 'The redirect URI is not registered in your Spotify app.';
    return j.error_description || j.error || `Spotify answered ${res.status}`;
  } catch {
    return `Spotify answered ${res.status}`;
  }
}

function toTokens(body: TokenResponse, clientId: string, refreshToken: string): SpotifyTokens {
  return {
    accessToken: body.access_token,
    // PKCE refresh tokens can rotate; keep the old one when none is returned
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: Date.now() + Math.max(60, body.expires_in) * 1000,
    scope: body.scope ?? '',
    clientId,
  };
}

let memo: SpotifyTokens | undefined;
let refreshing: Promise<SpotifyTokens> | undefined;

export async function loadSpotifyTokens(): Promise<SpotifyTokens | undefined> {
  if (memo) return memo;
  memo = (await kvGet<SpotifyTokens>(TOKENS_KEY))?.value;
  return memo;
}

/** Uses the refresh token. Only one refresh runs at a time. Revoked refresh token = disconnected. */
export function refreshSpotifyTokens(): Promise<SpotifyTokens> {
  refreshing ??= (async () => {
    const current = await loadSpotifyTokens();
    if (!current) throw new SpotifyAuthError('Connect Spotify first.');
    const res = await fetchImpl(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshBody({ clientId: current.clientId, refreshToken: current.refreshToken }),
    });
    if (!res.ok) {
      const msg = await tokenError(res);
      if (res.status === 400 || res.status === 401) {
        await disconnectSpotify({ keepClientId: true });
        throw new SpotifyAuthError(`Spotify signed you out (${msg}). Connect again.`, 'expired');
      }
      throw new SpotifyAuthError(msg, 'exchange_failed');
    }
    const next = toTokens((await res.json()) as TokenResponse, current.clientId, current.refreshToken);
    await kvSet(TOKENS_KEY, next);
    memo = next;
    return next;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** A valid access token (refreshes when it expires within a minute). */
export async function getSpotifyAccessToken(): Promise<string> {
  const t = await loadSpotifyTokens();
  if (!t) throw new SpotifyAuthError('Connect Spotify first.');
  if (t.expiresAt - SKEW_MS > Date.now()) return t.accessToken;
  return (await refreshSpotifyTokens()).accessToken;
}

export async function isSpotifyConnected(): Promise<boolean> {
  return Boolean(await loadSpotifyTokens());
}

export async function disconnectSpotify(opts: { keepClientId?: boolean } = { keepClientId: true }): Promise<void> {
  memo = undefined;
  await kvDelete(TOKENS_KEY);
  await kvDelete(PENDING_KEY);
  const settings = await getSettings();
  const clientId = opts.keepClientId ? settings.connections.spotify?.clientId : undefined;
  await saveSettings({ connections: { ...settings.connections, spotify: { connected: false, clientId } } });
}

/** Saves the display name shown on the Music services card. */
export async function rememberSpotifyName(displayName: string | undefined): Promise<void> {
  const settings = await getSettings();
  const prev = settings.connections.spotify ?? { connected: true };
  await saveSettings({ connections: { ...settings.connections, spotify: { ...prev, displayName } } });
}
