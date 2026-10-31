// OAuth 2.0 Authorization Code with PKCE (RFC 7636) for Spotify, fully client side: no client secret.

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** What Host-Caster asks for: read playlists + liked songs, play in the browser (SDK), control the user's devices. */
export const SPOTIFY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** 43..128 chars from the unreserved set (RFC 7636 section 4.1). */
export function randomVerifier(length = 64): string {
  if (length < 43 || length > 128) throw new RangeError('PKCE verifier must be 43-128 characters');
  // rejection sampling keeps every character equally likely (256 is not a multiple of 66)
  const limit = 256 - (256 % UNRESERVED.length);
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < length) out += UNRESERVED[b % UNRESERVED.length];
    }
  }
  return out;
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 challenge = base64url(sha256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes?: string[];
  /** show the account picker even when signed in */
  showDialog?: boolean;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: opts.challenge,
    state: opts.state,
    scope: (opts.scopes ?? SPOTIFY_SCOPES).join(' '),
  });
  if (opts.showDialog) q.set('show_dialog', 'true');
  return `${SPOTIFY_AUTHORIZE_URL}?${q.toString()}`;
}

/** Form bodies for the token endpoint (public client: client_id, no secret). */
export function codeExchangeBody(opts: { clientId: string; code: string; redirectUri: string; verifier: string }) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
}

export function refreshBody(opts: { clientId: string; refreshToken: string }) {
  return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: opts.refreshToken, client_id: opts.clientId });
}

/**
 * Spotify redirect URI rules (2025+): https, a loopback IP literal (http://127.0.0.1:PORT, http://[::1]:PORT) or a
 * custom scheme. "localhost" is not accepted. Returns a problem to show, or undefined when fine.
 */
export function redirectUriProblem(uri: string): string | undefined {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'The redirect address is not valid.';
  }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:') {
    if (u.hostname === '127.0.0.1' || u.hostname === '[::1]') return undefined;
    if (u.hostname === 'localhost') return 'Spotify does not accept "localhost". Open Host-Caster at http://127.0.0.1 instead.';
    return 'Spotify only accepts https addresses (or 127.0.0.1). Open Host-Caster over https to connect Spotify.';
  }
  return undefined; // custom scheme (native app)
}
