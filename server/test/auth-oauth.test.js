import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeProviders } from './fake-providers.js';
import { appPkce, bindingCookieOf, cookieOf, localUser, makeApp, oauth } from './helpers.js';

const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

async function setup(t, env = {}) {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, { ...fake.env, ...env });
  return { app, fake };
}

test('Google start asks for PKCE, offline access and incremental scopes', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/auth/google/start?scopes=calendar,gmail,bogus' });
  const loc = new URL(res.headers.location);
  assert.equal(loc.pathname, '/google/auth');
  const q = loc.searchParams;
  assert.equal(q.get('client_id'), 'g-id');
  assert.equal(q.get('redirect_uri'), 'http://hostcaster.test/auth/google/callback');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('code_challenge').length >= 43);
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('include_granted_scopes'), 'true');
  assert.match(q.get('prompt'), /consent/);
  assert.deepEqual(q.get('scope').split(' '), ['openid', 'email', 'profile', CAL, GMAIL]);
  const plain = new URL((await app.inject({ method: 'GET', url: '/auth/google/start' })).headers.location);
  assert.equal(plain.searchParams.get('prompt'), 'select_account');
});

test('Google web sign-in sets a cookie session; scopes are recorded', async (t) => {
  const { app, fake } = await setup(t);
  const { cb } = await oauth(app, 'google', { query: '?scopes=calendar,gmail', code: `alice|openid email ${CAL} ${GMAIL}|1` });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, 'http://hostcaster.test/#/?signedIn=google');
  const cookie = cookieOf(cb);
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  assert.equal(me.user.email, 'alice@gmail.test');
  assert.equal(me.user.name, 'User alice');
  assert.deepEqual(me.user.providers, ['google']);
  assert.deepEqual(me.user.identities[0].scopes, ['calendar', 'gmail']);
  // the token call carried the PKCE verifier and the client secret
  const tokenCall = fake.log.find((r) => r.path === '/google/token');
  const form = new URLSearchParams(tokenCall.body);
  assert.ok(form.get('code_verifier'));
  assert.equal(form.get('client_secret'), 'g-secret');
  // tokens are sealed at rest
  const row = app.db.prepare("SELECT tokens_enc FROM identities WHERE provider = 'google'").get();
  assert.match(row.tokens_enc, /^v1\./);
  assert.doesNotMatch(row.tokens_enc, /at-alice/);

  // signing in again returns the same user
  const again = await oauth(app, 'google', { code: 'alice|openid email profile|0' });
  const me2 = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(again.cb) } })).json();
  assert.equal(me2.user.id, me.user.id);
});

test('native flow: deep link code -> one-time exchange -> bearer', async (t) => {
  const { app } = await setup(t);
  const pkce = appPkce();
  const { cb } = await oauth(app, 'google', { query: `?app=1&cc=${pkce.challenge}`, code: 'bob' });
  const loc = new URL(cb.headers.location);
  assert.equal(loc.protocol, 'hostcaster:');
  assert.equal(loc.host, 'auth');
  const code = loc.searchParams.get('code');
  assert.ok(code);
  assert.equal(cb.headers['set-cookie'], undefined);
  const ex = await app.inject({ method: 'POST', url: '/api/auth/exchange', headers: { 'x-hostcaster': '1' }, payload: { code, verifier: pkce.verifier } });
  assert.equal(ex.statusCode, 200);
  const { token, kind, user } = ex.json();
  assert.equal(kind, 'app');
  assert.equal(user.email, 'bob@gmail.test');
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.json().kind, 'app');
  const reuse = await app.inject({ method: 'POST', url: '/api/auth/exchange', headers: { 'x-hostcaster': '1' }, payload: { code, verifier: pkce.verifier } });
  assert.equal(reuse.json().error.code, 'code_invalid');
});

test('X sign-in uses PKCE + Basic client auth; link via ticket; unlink rules', async (t) => {
  const { app, fake } = await setup(t, { ALLOW_LOCAL_ACCOUNTS: 'true' });
  const { start, cb } = await oauth(app, 'x', { code: '777' });
  assert.equal(start.searchParams.get('scope'), 'users.read tweet.read');
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(cb.headers.location, 'http://hostcaster.test/#/?signedIn=x');
  const cookie = cookieOf(cb);
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user;
  assert.equal(me.name, 'Radio Fan');
  assert.equal(me.avatarUrl, 'https://pbs.test/a_400x400.jpg');
  assert.equal(me.identities[0].label, '@radiofan');
  assert.ok(fake.log.some((r) => r.path === '/x/token' && r.headers.authorization.startsWith('Basic ')));

  // link Google with a ticket (what the native app does)
  const ticket = (await app.inject({ method: 'POST', url: '/api/auth/link-ticket', headers: { cookie, 'x-hostcaster': '1' } })).json().ticket;
  const pkce = appPkce();
  const linked = await oauth(app, 'google', { query: `?app=1&cc=${pkce.challenge}&link=${ticket}&scopes=youtube`, code: 'carol|openid https://www.googleapis.com/auth/youtube.readonly|1' });
  const back = new URL(linked.cb.headers.location);
  assert.equal(`${back.protocol}//${back.host}`, 'hostcaster://auth');
  assert.equal(back.searchParams.get('provider'), 'google');
  // nothing is linked until the app finishes with its own session and verifier
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user.providers, ['x']);
  const finish = await app.inject({
    method: 'POST',
    url: '/api/auth/link/finish',
    headers: { cookie, 'x-hostcaster': '1' },
    payload: { code: back.searchParams.get('linkcode'), verifier: pkce.verifier },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.equal(finish.json().linked, 'google');
  const me2 = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user;
  assert.deepEqual(me2.providers.sort(), ['google', 'x']);
  assert.deepEqual(me2.identities.find((i) => i.provider === 'google').scopes, ['youtube']);

  // the same Google account cannot be linked to a second user
  const other = await localUser(app, 'other@example.com');
  const stolen = await oauth(app, 'google', { query: '?link=1', code: 'carol', headers: { cookie: other.cookie } });
  assert.match(stolen.cb.headers.location, /error=identity_in_use/);

  // unlink X keeps Google; then Google is the last way in
  const call = (method, url) => app.inject({ method, url, headers: { cookie, 'x-hostcaster': '1' } });
  assert.equal((await call('DELETE', '/api/me/identities/x')).statusCode, 200);
  assert.ok(fake.log.some((r) => r.path === '/x/revoke'));
  assert.equal((await call('DELETE', '/api/me/identities/google')).json().error.code, 'last_sign_in');
});

test('web link with the cookie adds scopes to the signed-in user and keeps the refresh token', async (t) => {
  const { app } = await setup(t);
  const first = await oauth(app, 'google', { code: `dan|openid ${CAL}|1` });
  const cookie = cookieOf(first.cb);
  const more = await oauth(app, 'google', { query: '?scopes=gmail&return=/settings/connections', code: `dan|openid ${CAL} ${GMAIL}|0`, headers: { cookie } });
  assert.equal(more.cb.headers.location, 'http://hostcaster.test/#/settings/connections?linked=google');
  const row = app.db.prepare("SELECT * FROM identities WHERE provider = 'google'").get();
  assert.equal(row.scopes, 'calendar gmail');
  const tokens = JSON.parse(app.sealer.open(row.tokens_enc, `identity:google:${row.subject}`));
  assert.match(tokens.refresh_token, /^rt-dan-/);
});

test('bad state, denied consent, failed exchange and disabled providers redirect with an error', async (t) => {
  const { app } = await setup(t);
  const bad = await app.inject({ method: 'GET', url: '/auth/google/callback?state=nope&code=x' });
  assert.equal(bad.headers.location, 'http://hostcaster.test/#/sign-in?error=state_invalid');
  const started = await app.inject({ method: 'GET', url: '/auth/google/start' });
  const start = new URL(started.headers.location);
  const denied = await app.inject({
    method: 'GET',
    url: `/auth/google/callback?state=${start.searchParams.get('state')}&error=access_denied`,
    headers: { cookie: bindingCookieOf(started) },
  });
  assert.equal(denied.headers.location, 'http://hostcaster.test/#/sign-in?error=access_denied');
  const failed = await oauth(app, 'google', { query: `?app=1&cc=${appPkce().challenge}`, code: 'bad' });
  assert.equal(failed.cb.headers.location, 'hostcaster://auth?error=token_revoked');

  const { app: off } = await makeApp(t);
  const res = await off.inject({ method: 'GET', url: '/auth/x/start?app=1' });
  assert.equal(res.headers.location, 'hostcaster://auth?error=provider_disabled');
});

test('deleting the account revokes Google tokens', async (t) => {
  const { app, fake } = await setup(t);
  const { cb } = await oauth(app, 'google', { code: `erin|openid ${CAL}|1` });
  const res = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: cookieOf(cb), 'x-hostcaster': '1' } });
  assert.equal(res.statusCode, 204);
  const revoke = fake.log.find((r) => r.path === '/google/revoke');
  assert.match(new URLSearchParams(revoke.body).get('token'), /^rt-erin-/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 0);
});
