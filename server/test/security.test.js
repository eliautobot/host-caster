// Security regressions from the review in .work/security-review.md. Each test failed before its fix.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { redactUrl } from '../src/index.js';
import { MAX_BATCH } from '../src/mcp/server.js';
import { classify } from '../src/net/egress.js';
import { startFakeProviders } from './fake-providers.js';
import { appPkce, bindingCookieOf, cookieOf, localUser, makeApp, oauth } from './helpers.js';

const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

test('percent-encoded paths get the same CSRF check and no-store as /api (self-hosted)', async (t) => {
  const { app } = await makeApp(t, { ALLOW_LOCAL_ACCOUNTS: '1' });
  const u = await localUser(app);
  for (const url of ['/%61pi/sync', '/api/%73ync', '/%61%70%69/sync']) {
    const r = await app.inject({ method: 'PUT', url, payload: { rev: 0, doc: {} }, headers: { cookie: u.cookie } });
    assert.equal(r.statusCode, 403, url);
    assert.equal(r.json().error.code, 'csrf', url);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sync_docs').get().n, 0);
  const me = await app.inject({ method: 'GET', url: '/%61pi/me', headers: { cookie: u.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.headers['cache-control'], 'no-store');
});

test('OAuth: a callback finished in another browser (login CSRF) is refused and signs no one in', async (t) => {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, fake.env);
  // the attacker starts and consents with their own account, then gets the victim to open the callback address
  const start = await app.inject({ method: 'GET', url: '/auth/google/start' });
  assert.ok(bindingCookieOf(start), 'the starting browser gets a binding cookie');
  const state = new URL(start.headers.location).searchParams.get('state');
  const victim = await app.inject({ method: 'GET', url: `/auth/google/callback?state=${state}&code=mallory` });
  assert.match(victim.headers.location, /error=state_invalid/);
  assert.equal(cookieOf(victim), undefined, 'no session cookie');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  // and a different browser's binding does not match either
  const other = await app.inject({ method: 'GET', url: '/auth/x/start' });
  const start2 = await app.inject({ method: 'GET', url: '/auth/google/start' });
  const state2 = new URL(start2.headers.location).searchParams.get('state');
  const mixed = await app.inject({ method: 'GET', url: `/auth/google/callback?state=${state2}&code=mallory`, headers: { cookie: bindingCookieOf(other) } });
  assert.match(mixed.headers.location, /error=state_invalid/);
});

test('native sign-in: the deep-link code only works with the verifier of the app that started it', async (t) => {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, fake.env);
  const old = await app.inject({ method: 'GET', url: '/auth/google/start?app=1' });
  assert.equal(old.headers.location, 'hostcaster://auth?error=app_outdated');

  const exchange = (payload) => app.inject({ method: 'POST', url: '/api/auth/exchange', headers: { 'x-hostcaster': '1' }, payload });
  const codeFor = async (pkce) => {
    const { cb } = await oauth(app, 'google', { query: `?app=1&cc=${pkce.challenge}`, code: 'bob' });
    return new URL(cb.headers.location).searchParams.get('code');
  };
  const pkce = appPkce();
  // another app that caught the deep link has the code but not the verifier
  assert.equal((await exchange({ code: await codeFor(pkce) })).json().error.code, 'code_invalid');
  assert.equal((await exchange({ code: await codeFor(pkce), verifier: appPkce().verifier })).json().error.code, 'code_invalid');
  const ok = await exchange({ code: await codeFor(pkce), verifier: pkce.verifier });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
});

test('native link tickets: opening a ticket links nothing; only its app, signed in to its account, finishes', async (t) => {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, { ...fake.env, ALLOW_LOCAL_ACCOUNTS: '1' });
  const mallory = await localUser(app, 'mallory@example.com');
  const ticket = async () => (await mallory.call('POST', '/api/auth/link-ticket')).json().ticket;
  const identities = () => app.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n;

  // a ticket in a web page is refused outright
  const web = await app.inject({ method: 'GET', url: `/auth/google/start?link=${await ticket()}&scopes=gmail` });
  assert.match(web.headers.location, /error=link_expired/);

  // Mallory sends the victim a start address with her ticket; the victim consents with their Google account
  const lure = async () => {
    const pkce = appPkce();
    const { cb } = await oauth(app, 'google', { query: `?app=1&cc=${pkce.challenge}&link=${await ticket()}&scopes=gmail`, code: `victim|openid ${GMAIL}|1` });
    return { pkce, linkcode: new URL(cb.headers.location).searchParams.get('linkcode') };
  };
  const first = await lure();
  assert.ok(first.linkcode, 'the code goes to the hostcaster:// app on the victim device, not to Mallory');
  assert.equal(identities(), 0, 'nothing is linked by the browser');
  // the victim's own app session cannot finish Mallory's link
  const victim = await localUser(app, 'victim@example.com');
  const r1 = await victim.call('POST', '/api/auth/link/finish', { code: first.linkcode, verifier: first.pkce.verifier });
  assert.equal(r1.json().error.code, 'code_invalid');
  // Mallory's session without the verifier cannot finish it either
  const second = await lure();
  const r2 = await mallory.call('POST', '/api/auth/link/finish', { code: second.linkcode });
  assert.equal(r2.json().error.code, 'code_invalid');
  assert.equal(identities(), 0);
});

test('egress: IPv4-compatible and NAT64 local-use IPv6 forms of inside addresses are not public', () => {
  assert.equal(classify('::7f00:1'), 'private');
  assert.equal(classify('::127.0.0.1'), 'private');
  assert.equal(classify('::a9fe:a9fe'), 'blocked');
  assert.equal(classify('64:ff9b:1::a00:1'), 'private');
  assert.equal(classify('::ffff:0:7f00:1'), 'private');
  assert.equal(classify('1.1.1.1'), 'public');
  assert.equal(classify('2606:4700::1111'), 'public');
});

test('MCP: a JSON-RPC batch is capped', async (t) => {
  const { app } = await makeApp(t, { ALLOW_LOCAL_ACCOUNTS: '1' });
  const u = await localUser(app);
  const url = new URL((await u.call('POST', '/api/connectors', { name: 'AI' })).json().url).pathname;
  const msg = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'send_note_to_hosts', arguments: { text: 'hi' } } });
  const big = await app.inject({ method: 'POST', url, payload: Array.from({ length: MAX_BATCH + 1 }, (_, i) => msg(i)) });
  assert.equal(big.statusCode, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  const ok = await app.inject({ method: 'POST', url, payload: Array.from({ length: MAX_BATCH }, (_, i) => msg(i)) });
  assert.equal(ok.statusCode, 200);
});

test('self-hosted pages cannot be framed', async (t) => {
  const { app, dataDir } = await makeApp(t);
  await app.close();
  const dist = join(dataDir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Host-Caster</title>');
  const { app: built } = await makeApp(t, { APP_DIST: dist });
  const page = await built.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
});

test('logged URLs carry no library stream key', () => {
  assert.equal(redactUrl('/api/library/stream/t1?k=dXNlci4xNzAwMDAwMDAwLm1hYw&x=1'), '/api/library/stream/t1?k=***&x=1');
});

test('the server keeps what is playing only while an AI app connection exists', async (t) => {
  const { app } = await makeApp(t, { ALLOW_LOCAL_ACCOUNTS: '1' });
  const u = await localUser(app);
  const stored = () => app.db.prepare("SELECT json FROM user_state WHERE key = 'now_playing'").get()?.json;
  const song = { playing: true, station: 'Home FM', track: { title: 'Private Song', artist: 'Someone' } };
  assert.equal((await u.call('POST', '/api/now-playing', song)).statusCode, 200);
  assert.equal(stored(), undefined, 'no AI app connected: nothing about the song is stored');
  const conn = (await u.call('POST', '/api/connectors', { name: 'AI' })).json();
  await u.call('POST', '/api/now-playing', song);
  assert.match(stored(), /Private Song/);
  assert.equal((await u.call('DELETE', `/api/connectors/${conn.id}`)).statusCode, 204);
  assert.equal(stored(), undefined, 'removing the last connection forgets it');
});
