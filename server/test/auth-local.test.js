import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword, hashPassword } from '../src/auth/password.js';
import { cookieOf, localUser, makeApp } from './helpers.js';

const H = { 'x-hostcaster': '1' };

test('scrypt hashes verify and reject', async () => {
  const h = await hashPassword('hunter2hunter2');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('hunter2hunter2', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('local signup, me, logout, login (cookie) with CSRF header required', async (t) => {
  const { app } = await makeApp(t);
  const noCsrf = await app.inject({ method: 'POST', url: '/api/auth/local/signup', payload: { email: 'a@b.co', password: '12345678' } });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, 'csrf');

  const weak = await app.inject({ method: 'POST', url: '/api/auth/local/signup', headers: H, payload: { email: 'a@b.co', password: 'short' } });
  assert.equal(weak.json().error.code, 'weak_password');

  const { cookie, user, call } = await localUser(app, 'Me@Example.com');
  assert.match(cookie, /^aw_session=/);
  assert.equal(user.email, 'me@example.com');
  assert.deepEqual(user.providers, ['local']);
  const me = await call('GET', '/api/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().kind, 'web');

  // cookie writes without the header are refused
  const noHeader = await app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie }, payload: { name: 'x' } });
  assert.equal(noHeader.statusCode, 403);
  const renamed = await call('PATCH', '/api/me', { name: 'Night Owl' });
  assert.equal(renamed.json().user.name, 'Night Owl');

  const dup = await app.inject({ method: 'POST', url: '/api/auth/local/signup', headers: H, payload: { email: 'me@example.com', password: '12345678' } });
  assert.equal(dup.statusCode, 409);

  assert.equal((await call('POST', '/api/auth/logout')).statusCode, 204);
  assert.equal((await call('GET', '/api/me')).statusCode, 401);

  const bad = await app.inject({ method: 'POST', url: '/api/auth/local/login', headers: H, payload: { email: 'me@example.com', password: 'nope-nope' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'bad_credentials');
  const good = await app.inject({ method: 'POST', url: '/api/auth/local/login', headers: H, payload: { email: 'me@example.com', password: 'correct horse battery' } });
  assert.equal(good.statusCode, 200);
  const me2 = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(good) } });
  assert.equal(me2.json().user.name, 'Night Owl');
});

test('app login returns a bearer token; bearer writes need no CSRF header', async (t) => {
  const { app } = await makeApp(t);
  await localUser(app);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/local/login',
    headers: H,
    payload: { email: 'dj@example.com', password: 'correct horse battery', app: true },
  });
  const { token, kind } = res.json();
  assert.equal(kind, 'app');
  assert.ok(token.length > 30);
  assert.equal(res.headers['set-cookie'], undefined);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).json().kind, 'app');
  const patch = await app.inject({ method: 'PATCH', url: '/api/me', headers: auth, payload: { name: 'Phone' } });
  assert.equal(patch.statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth });
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode, 401);
});

test('login is rate limited', async (t) => {
  const { app } = await makeApp(t);
  await localUser(app);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await app.inject({ method: 'POST', url: '/api/auth/local/login', headers: H, payload: { email: 'dj@example.com', password: 'wrong-pass' } });
  }
  assert.equal(last.statusCode, 429);
});

test('local accounts are off when OAuth is configured, unless allowed', async (t) => {
  const { app } = await makeApp(t, { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/local/signup', headers: H, payload: { email: 'a@b.co', password: '12345678' } });
  assert.equal(res.json().error.code, 'local_disabled');
  const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.deepEqual(cfg.signIn, { google: true, x: false, local: false });

  const { app: app2 } = await makeApp(t, { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', ALLOW_LOCAL_ACCOUNTS: 'true', ALLOW_SIGNUPS: 'false' });
  const closed = await app2.inject({ method: 'POST', url: '/api/auth/local/signup', headers: H, payload: { email: 'a@b.co', password: '12345678' } });
  assert.equal(closed.json().error.code, 'signups_closed');
});

test('secure public URL uses a __Host- cookie', async (t) => {
  const { app } = await makeApp(t, { PUBLIC_URL: 'https://radio.example.com' });
  const { cookie } = await localUser(app);
  assert.match(cookie, /^__Host-aw_session=/);
  const raw = await app.inject({ method: 'POST', url: '/api/auth/local/login', headers: H, payload: { email: 'dj@example.com', password: 'correct horse battery' } });
  assert.match(String(raw.headers['set-cookie']), /Secure/);
  assert.match(String(raw.headers['set-cookie']), /HttpOnly/);
  assert.match(String(raw.headers['set-cookie']), /SameSite=Lax/);
});

test('delete account removes the user and all rows; last sign-in cannot be unlinked', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  const unlink = await call('DELETE', '/api/me/identities/local');
  assert.equal(unlink.json().error.code, 'last_sign_in');
  await call('PUT', '/api/sync', { rev: 0, doc: { hosts: [{ id: 'h1', name: 'Maya' }] } });
  await call('PUT', '/api/secrets/brain:x', { value: 'sk-1' });
  assert.equal((await call('DELETE', '/api/me')).statusCode, 204);
  assert.equal((await call('GET', '/api/me')).statusCode, 401);
  for (const table of ['users', 'sessions', 'sync_docs', 'secrets']) {
    const col = table === 'users' ? 'id' : 'user_id';
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(user.id).n, 0, table);
  }
});

test('CORS reflects the origin without credentials and answers preflight', async (t) => {
  const { app } = await makeApp(t);
  const pre = await app.inject({
    method: 'OPTIONS',
    url: '/api/sync',
    headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'PUT' },
  });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'capacitor://localhost');
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  assert.equal(pre.headers['access-control-allow-credentials'], undefined);
  const get = await app.inject({ method: 'GET', url: '/api/config', headers: { origin: 'https://localhost' } });
  assert.equal(get.headers['access-control-allow-origin'], 'https://localhost');
  assert.equal(get.headers['cache-control'], 'no-store');
});
