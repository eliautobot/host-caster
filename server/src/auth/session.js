// Sessions: web = httpOnly cookie (CSRF header required on writes), app = Authorization: Bearer.
import { randomUUID } from 'node:crypto';
import { randomToken, sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';
import { getUser } from './users.js';

const DAY = 24 * 60 * 60 * 1000;
const TOUCH_EVERY = 10 * 60 * 1000;

export const cookieName = (config) => (config.cookieSecure ? '__Host-aw_session' : 'aw_session');

export function cookieOptions(config, maxAgeSec) {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: maxAgeSec };
}

/** Creates a session and returns its raw token (only the sha256 is stored). */
export function createSession(app, userId, kind, userAgent = '') {
  const token = randomToken(32);
  const t = Date.now();
  const expires = t + app.config.sessionDays * DAY;
  app.db
    .prepare(
      'INSERT INTO sessions (id, user_id, kind, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(sha256(token), userId, kind, String(userAgent).slice(0, 300), t, t, expires);
  return { token, expires };
}

export function setSessionCookie(app, reply, token) {
  reply.setCookie(cookieName(app.config), token, cookieOptions(app.config, app.config.sessionDays * 24 * 60 * 60));
}

export function clearSessionCookie(app, reply) {
  reply.clearCookie(cookieName(app.config), { path: '/' });
}

export function deleteSessionByToken(app, token) {
  app.db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

function readToken(app, req) {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return { token: auth.replace(/^bearer\s+/i, '').trim(), via: 'bearer' };
  const cookie = req.cookies?.[cookieName(app.config)];
  if (cookie) return { token: cookie, via: 'cookie' };
  return undefined;
}

/** onRequest hook: sets req.user / req.auth when a valid session is presented. */
export function sessionHook(app) {
  return async (req) => {
    req.user = undefined;
    req.auth = undefined;
    const found = readToken(app, req);
    if (!found?.token) return;
    const row = app.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(found.token));
    const t = Date.now();
    if (!row || row.expires_at < t) return;
    const user = getUser(app.db, row.user_id);
    if (!user) return;
    if (t - row.last_seen_at > TOUCH_EVERY) {
      // sliding expiry: active sessions stay signed in
      app.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(t, t + app.config.sessionDays * DAY, row.id);
    }
    req.user = user;
    req.auth = { sessionId: row.id, kind: row.kind, via: found.via, token: found.token };
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The path every gate decides on: the route the router matched ('/api/secrets/:ref'), not the raw URL, because the
 * router decodes percent escapes (/%61pi/sync runs /api/sync). Unmatched requests (404s) fall back to the raw path.
 * @param {import('fastify').FastifyRequest} req
 */
export function routePath(req) {
  return req.routeOptions?.url ?? req.url.split('?')[0];
}

/** CSRF: cookie-authenticated (or anonymous) writes to /api need the X-HostCaster: 1 header. */
export function csrfHook() {
  return async (req) => {
    if (SAFE.has(req.method)) return;
    const path = routePath(req);
    if (!path.startsWith('/api/')) return;
    if (req.auth?.via === 'bearer') return;
    // Stripe's webhook carries its own signature (online edition)
    if (path === '/api/billing/webhook') return;
    if (req.headers['x-hostcaster'] !== '1') {
      throw new HttpError(403, 'csrf', 'Missing X-HostCaster header');
    }
  };
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'not_signed_in', 'Sign in first');
  return req.user;
}

export function sessionInfo(req) {
  return { kind: req.auth?.kind ?? 'web' };
}

export const newId = () => randomUUID();
