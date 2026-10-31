// Ties a sign-in to whoever started it. OAuth state alone can be replayed in someone else's browser (login CSRF, or a
// victim's consent completing an attacker's link flow), so the browser that opens /auth/<provider>/start gets a short
// cookie and the callback must come back with it. The phone apps also keep a PKCE-style verifier (RFC 8252): the
// one-time hostcaster://auth?code= is useless to another app that catches the deep link, and a code the app did not
// ask for cannot sign it in.
import { createHash } from 'node:crypto';
import { randomToken, safeEqual, sha256 } from '../crypto.js';

const TTL_S = 10 * 60;
const VALUE = /^[A-Za-z0-9_-]{22,64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export const bindCookieName = (config) => (config.cookieSecure ? '__Host-hc_signin' : 'hc_signin');

/**
 * Start of a browser sign-in: sets (or renews) this browser's binding cookie and returns the hash the flow keeps.
 * The value is reused, so sign-ins in two tabs both work. SameSite=None on https because Apple answers with a
 * cross-site form POST; the value proves nothing by itself, it only has to match.
 */
export function bindBrowser(app, req, reply) {
  const name = bindCookieName(app.config);
  const existing = req.cookies?.[name];
  const value = typeof existing === 'string' && VALUE.test(existing) ? existing : randomToken(24);
  reply.setCookie(name, value, {
    path: '/',
    httpOnly: true,
    secure: app.config.cookieSecure,
    sameSite: app.config.cookieSecure ? 'none' : 'lax',
    maxAge: TTL_S,
  });
  return sha256(value);
}

/** Callback: did this browser start the flow? */
export function browserMatches(app, req, bindHash) {
  const value = req.cookies?.[bindCookieName(app.config)];
  return Boolean(bindHash && typeof value === 'string' && safeEqual(sha256(value), bindHash));
}

/** The app's code challenge (`cc`: base64url sha256 of its verifier) from the start URL, if well formed. */
export const appChallengeOf = (query) => (CHALLENGE.test(String(query?.cc ?? '')) ? String(query.cc) : undefined);

/** /api/auth/exchange: the verifier must hash to the challenge the app sent when it started. */
export function verifierMatches(challenge, verifier) {
  if (!challenge || typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}
