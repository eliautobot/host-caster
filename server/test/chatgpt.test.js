import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jwkThumbprintUri, loadHostId } from '../src/chatgpt/host.js';
import { createOidc } from '../src/chatgpt/oidc.js';
import { startFakeChatGPT } from './fake-chatgpt.js';
import { localUser, makeApp } from './helpers.js';

const BRAIN = { id: 'gpt', name: 'ChatGPT plan', kind: 'chatgpt', model: 'gpt-6.1-sol', transport: 'server' };

async function setup(t, env = {}) {
  const fake = await startFakeChatGPT();
  t.after(() => fake.close());
  const made = await makeApp(t, { CHATGPT_ISSUER: fake.base, CHATGPT_API_BASE: `${fake.base}/v1`, CHATGPT_CALLBACK_PORT: '0', ...env });
  const a = await localUser(made.app, 'a@example.com');
  return { ...made, fake, a };
}

/** start -> fake consent (302) -> the callback address the browser would open */
async function consent(user, body = {}) {
  const start = await user.call('POST', '/api/chatgpt/start', body);
  assert.equal(start.statusCode, 200, start.body);
  const res = await fetch(start.json().authorizeUrl, { redirect: 'manual' });
  assert.equal(res.status, 302, await res.text());
  return { start: start.json(), authorize: new URL(start.json().authorizeUrl), callback: res.headers.get('location') };
}

/** connect by pasting the callback address (works from any device) */
async function connectByPaste(user, body = {}) {
  const c = await consent(user, body);
  const fin = await user.call('POST', '/api/chatgpt/finish', { url: c.callback });
  return { ...c, fin };
}

const chat = (user, extra = {}) =>
  user.call('POST', '/api/ai/chat', { brain: BRAIN, brainId: BRAIN.id, system: 'You are a radio host.', messages: [{ role: 'user', content: 'Mic check' }], maxTokens: 60, ...extra });

const responsesCalls = (fake) => fake.log.filter((r) => r.path === '/v1/responses');
const tokenCalls = (fake, grant) => fake.log.filter((r) => r.path === '/api/accounts/oauth/token' && new URLSearchParams(r.body).get('grant_type') === grant);

test('host id: RFC 9278 JWK thumbprint, persisted once (0600) and stable', async (t) => {
  const { dataDir, app, a } = await setup(t);
  const c = await consent(a);
  const file = join(dataDir, 'chatgpt-host.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.match(saved.hostId, /^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.hostId, jwkThumbprintUri(saved.publicJwk));
  assert.equal(loadHostId(dataDir), saved.hostId);
  assert.equal(c.authorize.searchParams.get('ext_agent_host_id'), saved.hostId);
  assert.equal(app.chatgpt.hostId(), saved.hostId);
  const { statSync } = await import('node:fs');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('first sign-in: dynamic registration request with PKCE, state, nonce and the plan scopes', async (t) => {
  const { a, fake } = await setup(t);
  const { authorize: u, start } = await consent(a);
  assert.equal(u.origin + u.pathname, `${fake.base}/api/accounts/authorize`);
  const q = u.searchParams;
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('agent_name_hint'), 'Host-Caster');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(q.get('resource'), 'https://api.openai.com/v1');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.get('state').length >= 32 && q.get('nonce').length >= 24);
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(start.redirectUri, q.get('redirect_uri'));
  assert.equal(q.get('id_token_hint'), null);
});

test('loopback callback on this machine connects the account; tokens stay sealed on the server', async (t) => {
  const { a, app, fake, dataDir } = await setup(t);
  const c = await consent(a);
  assert.equal(c.start.listening, true);
  const page = await fetch(c.callback);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Return to Host-Caster/);
  const st = (await a.call('GET', '/api/chatgpt/status')).json();
  assert.equal(st.connected, true);
  assert.equal(st.planUsage, true);
  assert.equal(st.welcome, true);
  assert.deepEqual(st.account, { email: 'listener@example.com', name: 'Alex Listener' });
  assert.equal(st.manageUsageUrl, 'https://chatgpt.com/settings/usage');
  assert.doesNotMatch(JSON.stringify(st), /at_|rt_|eyJ/);
  // the issued client id (not dynamic_agent_client) was used for the exchange
  const exchange = new URLSearchParams(tokenCalls(fake, 'authorization_code')[0].body);
  assert.match(exchange.get('client_id'), /^oaiapp_/);
  assert.equal(exchange.get('resource'), 'https://api.openai.com/v1');
  assert.ok(exchange.get('code_verifier'));
  // nothing readable at rest
  const row = app.db.prepare('SELECT * FROM chatgpt_accounts').get();
  assert.match(row.tokens_enc, /^v1\./);
  const at = [...fake.access.keys()][0];
  assert.ok(!readFileSync(join(dataDir, 'hostcaster.db')).includes(Buffer.from(at)));
  // the welcome shows once
  await a.call('POST', '/api/chatgpt/welcome', {});
  assert.equal((await a.call('GET', '/api/chatgpt/status')).json().welcome, false);
  // a used state cannot be replayed
  assert.equal((await fetch(c.callback)).status, 400);
});

test('paste the address from another device; wrong user, wrong address and replays are refused', async (t) => {
  const { a, app } = await setup(t, { CHATGPT_CALLBACK_BIND: '203.0.113.7', CHATGPT_CALLBACK_PORT: '1455' });
  const b = await localUser(app, 'b@example.com');
  const c = await consent(a);
  assert.equal(c.start.listening, false);
  assert.match(c.callback, /^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/);
  // another Host-Caster user cannot finish (or steal) this sign-in
  assert.equal((await b.call('POST', '/api/chatgpt/finish', { url: c.callback })).statusCode, 400);
  const c2 = await consent(a);
  const moved = c2.callback.replace(':1455/', ':1456/');
  assert.equal((await a.call('POST', '/api/chatgpt/finish', { url: moved })).json().error.code, 'chatgpt_flow');
  const c3 = await consent(a);
  assert.equal((await a.call('POST', '/api/chatgpt/finish', { url: 'https://example.com/x' })).statusCode, 400);
  const fin = await a.call('POST', '/api/chatgpt/finish', { url: `  ${c3.callback} ` });
  assert.equal(fin.statusCode, 200, fin.body);
  assert.equal(fin.json().connected, true);
  assert.equal((await a.call('POST', '/api/chatgpt/finish', { url: c3.callback })).statusCode, 400);
  assert.equal((await b.call('GET', '/api/chatgpt/status')).json().connected, false);
});

test('inference: Responses API, store false, stream true, instructions, no unsupported fields', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  const res = await chat(a, { messages: [{ role: 'system', content: 'Extra rule.' }, { role: 'user', content: 'Mic check' }], temperature: 0.7 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().text, 'Hello from your ChatGPT plan, the mic is live.');
  const sent = JSON.parse(responsesCalls(fake)[0].body);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(sent.model, 'gpt-6.1-sol');
  assert.equal(sent.instructions, 'You are a radio host.');
  assert.deepEqual(sent.input.map((m) => m.role), ['developer', 'user']);
  for (const k of ['temperature', 'top_p', 'max_output_tokens', 'user', 'metadata', 'previous_response_id']) assert.ok(!(k in sent), k);
  assert.match(responsesCalls(fake)[0].headers.authorization, /^Bearer at_/);
  // JSON mode asks for a JSON object; a model that refuses reasoning gets the request again without it
  fake.state.rejectReasoning = true;
  const j = await chat(a, { json: true });
  assert.equal(j.statusCode, 200, j.body);
  assert.match(j.json().text, /"lines"/);
  const last = JSON.parse(responsesCalls(fake).at(-1).body);
  assert.equal(last.reasoning, undefined);
  assert.deepEqual(last.text, { format: { type: 'json_object' } });
});

test('models: the account catalog, picker models only, in server order', async (t) => {
  const { a } = await setup(t);
  assert.equal((await a.call('GET', '/api/chatgpt/models')).json().error.code, 'chatgpt_not_connected');
  await connectByPaste(a);
  const res = await a.call('GET', '/api/chatgpt/models');
  assert.deepEqual(res.json().models, [
    { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
    { slug: 'gpt-6.1-luna', displayName: 'GPT-6.1 Luna' },
  ]);
  assert.deepEqual((await a.call('POST', '/api/ai/models', { brain: BRAIN, brainId: 'gpt' })).json().models, ['gpt-6.1-sol', 'gpt-6.1-luna']);
});

test('refresh: near expiry, issued client id, rotation saved, one refresh for parallel calls', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  fake.expireAccess();
  const [r1, r2] = await Promise.all([chat(a), chat(a)]);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r2.statusCode, 200, r2.body);
  const refreshes = tokenCalls(fake, 'refresh_token');
  assert.equal(refreshes.length, 1);
  const f = new URLSearchParams(refreshes[0].body);
  assert.match(f.get('client_id'), /^oaiapp_/);
  assert.equal(f.get('resource'), 'https://api.openai.com/v1');
  assert.equal(f.get('scope'), null);
  // the replacement refresh token is the one used next time (the old one would be refresh_token_reused)
  fake.expireAccess();
  assert.equal((await chat(a)).statusCode, 200);
  const second = new URLSearchParams(tokenCalls(fake, 'refresh_token')[1].body);
  assert.notEqual(second.get('refresh_token'), f.get('refresh_token'));
  assert.equal((await a.call('GET', '/api/chatgpt/status')).json().connected, true);
});

test('plan limit: 429 with Manage usage guidance, then paused; Test (force) asks again', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  fake.state.failNext = 'limit';
  const res = await chat(a);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error.code, 'chatgpt_limit');
  assert.match(res.json().error.message, /usage limit reached/i);
  const before = responsesCalls(fake).length;
  assert.equal((await chat(a)).json().error.code, 'chatgpt_limit');
  assert.equal(responsesCalls(fake).length, before, 'paused: no new plan request');
  assert.ok((await a.call('GET', '/api/chatgpt/status')).json().limitedUntil > Date.now());
  // a limit that arrives inside the stream
  fake.state.failNext = 'limit-stream';
  const s = await chat(a, { force: true });
  assert.equal(s.json().error.code, 'chatgpt_limit');
  assert.equal(responsesCalls(fake).length, before + 1);
  const ok = await chat(a, { force: true });
  assert.equal(ok.statusCode, 200);
});

test('stream problems and temporary outages keep the connection', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  for (const fail of ['incomplete', 'cut']) {
    fake.state.failNext = fail;
    const res = await chat(a);
    assert.equal(res.statusCode, 502, fail);
    assert.equal(res.json().error.code, 'chatgpt_error');
  }
  fake.state.failNext = 'unavailable';
  assert.equal((await chat(a)).json().error.code, 'chatgpt_unavailable');
  fake.state.failNext = 'not-eligible';
  assert.equal((await chat(a)).json().error.code, 'chatgpt_not_eligible');
  fake.expireAccess();
  fake.state.refreshFails = 'unavailable';
  assert.equal((await chat(a)).json().error.code, 'chatgpt_unavailable');
  fake.state.refreshFails = undefined;
  assert.equal((await chat(a)).statusCode, 200);
  assert.equal((await a.call('GET', '/api/chatgpt/status')).json().connected, true);
});

test('revoked in ChatGPT settings: 401, refresh refused, signed out with a clear message', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  for (const r of fake.refreshes.values()) r.revoked = true;
  fake.access.clear();
  const res = await chat(a);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'chatgpt_signed_out');
  assert.match(res.json().error.message, /Continue with ChatGPT/);
  const st = (await a.call('GET', '/api/chatgpt/status')).json();
  assert.equal(st.connected, false);
  assert.equal(st.status, 'expired');
  assert.equal((await chat(a)).json().error.code, 'chatgpt_signed_out');
});

test('disconnect revokes the refresh token; the next sign-in reuses the registration', async (t) => {
  const { a, fake, app } = await setup(t);
  const first = await connectByPaste(a);
  const clientId = new URL(first.callback).searchParams.get('client_id');
  const out = await a.call('POST', '/api/chatgpt/disconnect', {});
  assert.deepEqual(out.json(), { revoked: true });
  const rev = new URLSearchParams(fake.log.find((r) => r.path === '/api/accounts/oauth/revoke').body);
  assert.equal(rev.get('token_type_hint'), 'refresh_token');
  assert.equal(rev.get('client_id'), clientId);
  assert.match(rev.get('token'), /^rt_/);
  const st = (await a.call('GET', '/api/chatgpt/status')).json();
  assert.equal(st.connected, false);
  assert.equal(st.status, 'signed_out');
  assert.equal(app.db.prepare('SELECT tokens_enc FROM chatgpt_accounts').get().tokens_enc, null);
  assert.equal((await chat(a)).json().error.code, 'chatgpt_not_connected');
  const again = await connectByPaste(a);
  const q = again.authorize.searchParams;
  assert.equal(q.get('client_id'), clientId);
  assert.equal(q.get('agent_name_hint'), null);
  assert.equal(q.get('login_hint'), 'listener@example.com');
  assert.equal(again.fin.json().connected, true);
  assert.equal(fake.clients.size, 1, 'no second registration');
});

test('plan use not granted: signed in but off; turning it on asks for consent again', async (t) => {
  const { a, fake } = await setup(t);
  fake.state.grantPlan = false;
  await connectByPaste(a);
  const st = (await a.call('GET', '/api/chatgpt/status')).json();
  assert.equal(st.status, 'not_enabled');
  assert.equal(st.planUsage, false);
  assert.equal(st.connected, false);
  assert.equal((await chat(a)).json().error.code, 'chatgpt_not_enabled');
  assert.equal(responsesCalls(fake).length, 0);
  fake.state.grantPlan = true;
  const again = await connectByPaste(a, { reconsent: true });
  assert.equal(again.authorize.searchParams.get('prompt'), 'consent');
  assert.equal((await a.call('GET', '/api/chatgpt/status')).json().connected, true);
});

test('declined consent: no code exchange, the attempt reports it', async (t) => {
  const { a, fake } = await setup(t);
  fake.state.denyNext = true;
  const { fin } = await connectByPaste(a);
  assert.equal(fin.json().error.code, 'chatgpt_denied');
  assert.equal(tokenCalls(fake, 'authorization_code').length, 0);
  const st = (await a.call('GET', '/api/chatgpt/status')).json();
  assert.equal(st.attempt.status, 'error');
  assert.equal(st.connected, false);
});

test('each Host-Caster user uses their own ChatGPT account; a different account on reauth is refused', async (t) => {
  const { a, app, fake } = await setup(t);
  const b = await localUser(app, 'b@example.com');
  await connectByPaste(a);
  assert.equal((await chat(b)).json().error.code, 'chatgpt_not_connected');
  fake.state.user = { sub: 'user-beta', email: 'other@example.com', name: 'Bo Other' };
  await connectByPaste(b);
  await chat(a);
  await chat(b);
  const subs = responsesCalls(fake).map((r) => fake.access.get(r.headers.authorization.replace('Bearer ', ''))?.sub);
  assert.deepEqual(subs, ['user-alpha', 'user-beta']);
  assert.equal(fake.clients.size, 2);
  // A signs out; the browser is now signed in to B's ChatGPT: reusing A's registration must not swap accounts
  await a.call('POST', '/api/chatgpt/disconnect', {});
  const swapped = await consent(a);
  assert.equal(swapped.authorize.searchParams.get('login_hint'), 'listener@example.com');
  const res = await a.call('POST', '/api/chatgpt/finish', { url: swapped.callback });
  assert.equal(res.json().error.code, 'chatgpt_account_mismatch');
  assert.equal((await a.call('GET', '/api/chatgpt/status')).json().account.email, 'listener@example.com');
});

test('deleting the Host-Caster account revokes the ChatGPT session', async (t) => {
  const { a, fake } = await setup(t);
  await connectByPaste(a);
  const del = await a.call('DELETE', '/api/me', {});
  assert.equal(del.statusCode, 204);
  assert.equal(fake.log.filter((r) => r.path === '/api/accounts/oauth/revoke').length, 1);
});

test('CHATGPT_PLAN=false turns the feature off', async (t) => {
  const { a, app } = await setup(t, { CHATGPT_PLAN: 'false' });
  assert.equal((await a.call('POST', '/api/chatgpt/start', {})).json().error.code, 'chatgpt_off');
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().chatgptPlan, false);
});

test('ID token checks: signature, issuer, audience, azp, expiry and nonce', async (t) => {
  const fake = await startFakeChatGPT();
  t.after(() => fake.close());
  const oidc = createOidc(fake.base);
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: fake.base, sub: 's1', aud: ['oaiapp_x'], nonce: 'n1', iat: now, exp: now + 600, email: 'e@example.com' };
  assert.deepEqual(await oidc.verifyIdToken(fake.signJwt(good), { clientId: 'oaiapp_x', nonce: 'n1' }), { sub: 's1', email: 'e@example.com' });
  const bad = async (claims, expect = { clientId: 'oaiapp_x', nonce: 'n1' }, mutate = (x) => x) =>
    assert.equal((await oidc.verifyIdToken(mutate(fake.signJwt({ ...good, ...claims })), expect).catch((e) => e)).code, 'chatgpt_identity');
  await bad({ iss: 'https://evil.example' });
  await bad({ aud: ['oaiapp_other'] });
  await bad({ aud: ['oaiapp_x', 'oaiapp_other'] });
  await bad({ azp: 'oaiapp_other' });
  await bad({ exp: now - 60 });
  await bad({ nonce: 'other' });
  await bad({ sub: '' });
  await bad({}, undefined, (tok) => `${tok.slice(0, -4)}AAAA`);
  await bad({}, undefined, (tok) => tok.split('.').slice(0, 2).join('.'));
  // a token signed by another key with the same kid
  const other = await startFakeChatGPT();
  t.after(() => other.close());
  await bad({}, undefined, () => other.signJwt(good));
});
