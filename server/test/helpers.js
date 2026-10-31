import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/index.js';

/** Builds an app on a temp DATA_DIR; cleans up after the test. */
export async function makeApp(t, env = {}, opts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hostcaster-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, APP_DIST: join(dataDir, 'no-dist'), ...env });
  const app = await createServer(config, { logger: false, ...opts });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, config, dataDir };
}

/** The sign-in binding cookie ("hc_signin=..."; __Host- on https) a /auth/<provider>/start answer set. */
export function bindingCookieOf(res) {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return all.map((c) => c.split(';')[0]).find((c) => /^(__Host-)?hc_signin=/.test(c));
}

/** What the phone app keeps (verifier) and sends with ?app=1 (cc = its sha256, base64url). */
export function appPkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Pulls "name=value" out of a set-cookie header. */
export function cookieOf(res) {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? first.split(';')[0] : undefined;
}

/** Signs up a local account; returns a request helper bound to its cookie session. */
export async function localUser(app, email = 'dj@example.com', password = 'correct horse battery') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/local/signup',
    headers: { 'x-hostcaster': '1' },
    payload: { email, password, name: 'DJ' },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = cookieOf(res);
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, payload, headers: { cookie, 'x-hostcaster': '1', ...headers } });
  return { cookie, user: res.json().user, call };
}

/** Runs start -> (fake consent) -> callback for a provider. Returns the consent URL and the callback response. */
export async function oauth(app, provider, { query = '', code, headers = {} }) {
  const start = await app.inject({ method: 'GET', url: `/auth/${provider}/start${query}`, headers });
  assert.equal(start.statusCode, 302, start.body);
  const loc = new URL(start.headers.location);
  const state = loc.searchParams.get('state');
  // the same browser comes back: its sign-in binding cookie goes along with any session cookie
  const bind = bindingCookieOf(start);
  const cookie = [headers.cookie, bind].filter(Boolean).join('; ');
  const cb = await app.inject({
    method: 'GET',
    url: `/auth/${provider}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
  });
  return { start: loc, cb, bind };
}
