// The local helper without Electron: the per-launch secret, origin and host checks, "Use your ChatGPT plan" end to
// end against the fake OpenAI (tokens sealed on disk, never in the file in clear), and the device proxy.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFakeChatGPT } from '../../server/test/fake-chatgpt.js';
import { startHelper } from '../main/helper/server.js';

const ORIGIN = 'app://host-caster';

/** stands in for Electron safeStorage */
function testKeychain() {
  const key = randomBytes(32);
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    open(sealed) {
      const buf = Buffer.from(sealed, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

describe('desktop local helper', () => {
  let fake;
  let helper;
  let dir;
  let enabled = false;
  const call = (path, init = {}) =>
    fetch(`${helper.url}${path}`, {
      ...init,
      headers: { 'x-hc-helper': helper.token, origin: ORIGIN, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  const post = (path, body = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

  before(async () => {
    fake = await startFakeChatGPT({ port: 0 });
    dir = mkdtempSync(join(tmpdir(), 'hc-desktop-helper-'));
    helper = await startHelper({
      dataDir: dir,
      keychain: testKeychain(),
      chatgptEnabled: () => enabled,
      appOrigin: ORIGIN,
      version: '9.9.9',
      chatgpt: { issuer: fake.base, apiBase: `${fake.base}/v1`, callbackPort: 0 },
    });
  });
  after(async () => {
    await helper?.close();
    await fake?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('binds 127.0.0.1 and needs the launch secret, the app origin and the exact host', async () => {
    assert.match(helper.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${helper.url}/health`)).status, 401);
    assert.equal((await fetch(`${helper.url}/health`, { headers: { 'x-hc-helper': 'nope' } })).status, 401);
    assert.equal((await call('/health', { headers: { origin: 'https://evil.example' } })).status, 403);
    const ok = await call('/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(await ok.json(), { ok: true, version: '9.9.9', chatgptPlan: false });
    // a page that rebinds a name to 127.0.0.1 sends its own Host
    const { request } = await import('node:http');
    const status = await new Promise((resolve) => {
      const r = request({ host: '127.0.0.1', port: helper.port, path: '/health', headers: { host: `evil.example:${helper.port}`, 'x-hc-helper': helper.token } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.end();
    });
    assert.equal(status, 403);
  });

  test('preflight from the app answers with private network access', async () => {
    const res = await fetch(`${helper.url}/api/chatgpt/status`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-hc-helper, content-type' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  });

  test('ChatGPT plan stays off until the setting is on', async () => {
    const s = await (await call('/api/chatgpt/status')).json();
    assert.equal(s.enabled, false);
    const res = await post('/api/chatgpt/start');
    assert.equal(res.status >= 400, true);
    assert.equal((await res.json()).error.code, 'chatgpt_off');
  });

  test('sign in with ChatGPT on this PC, chat on the plan, tokens sealed, disconnect revokes', async () => {
    enabled = true;
    const start = await (await post('/api/chatgpt/start')).json();
    assert.equal(start.listening, true);
    const authorize = new URL(start.authorizeUrl);
    assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(authorize.searchParams.get('agent_name_hint'), 'Host-Caster');
    assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    // the browser: fake consent, then the helper's own 127.0.0.1 callback
    const consent = await fetch(authorize, { redirect: 'manual' });
    assert.equal(consent.status, 302);
    const callback = await fetch(consent.headers.get('location'));
    const page = await callback.text();
    assert.equal(callback.status, 200);
    assert.match(page, /Your ChatGPT account is connected/);
    assert.match(page, /hostcaster:\/\/chatgpt/);

    const status = await (await call('/api/chatgpt/status')).json();
    assert.equal(status.connected, true);
    assert.equal(status.account.email, 'listener@example.com');
    assert.equal(status.welcome, true);

    const models = await (await call('/api/chatgpt/models')).json();
    assert.ok(models.models.length > 0);
    const chat = await post('/api/ai/chat', {
      brain: { kind: 'chatgpt', model: models.models[0].slug },
      system: 'You are a radio host.',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    assert.equal(chat.status, 200);
    const answer = await chat.json();
    assert.equal(typeof answer.text, 'string');
    assert.ok(answer.text.length > 0);

    // the file holds the registration and a sealed token set, never a token in clear
    const file = readFileSync(join(dir, 'chatgpt.json'), 'utf8');
    for (const t of [...fake.access.keys(), ...fake.refreshes.keys()]) assert.equal(file.includes(t), false);
    assert.match(file, /"tokens_enc":"[A-Za-z0-9+/=]+"/);

    // expired access token: refreshed with the sealed refresh token
    fake.expireAccess();
    assert.equal((await post('/api/ai/chat', { brain: { model: models.models[0].slug }, messages: [{ role: 'user', content: 'again' }] })).status, 200);

    const off = await (await post('/api/chatgpt/disconnect')).json();
    assert.equal(off.revoked, true);
    assert.equal((await (await call('/api/chatgpt/status')).json()).connected, false);
    assert.equal(readFileSync(join(dir, 'chatgpt.json'), 'utf8').includes('"tokens_enc":null'), true);
  });

  test('a pasted address that is not the callback is refused', async () => {
    const res = await post('/api/chatgpt/finish', { url: 'https://example.com/auth/callback?code=x&state=y' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'chatgpt_flow');
  });

  describe('device proxy', () => {
    let upstream;
    let seen;
    before(async () => {
      upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
          if (req.url === '/audio') {
            res.writeHead(200, { 'content-type': 'audio/mpeg' });
            return res.end(Buffer.from([0xff, 0xfb, 0x00, 0x01, 0x80, 0x7f]));
          }
          res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
          res.end(JSON.stringify({ ok: req.url !== '/missing' }));
        });
      });
      await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    });
    after(() => new Promise((r) => upstream.close(r)));
    const target = (path) => `/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.address().port}${path}`)}`;

    test('passes the method, body and the provider key, not the helper secret or cookies', async () => {
      const res = await call(target('/v1/chat/completions'), {
        method: 'POST',
        headers: { authorization: 'Bearer sk-provider', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(seen.method, 'POST');
      assert.equal(seen.body, '{"model":"m"}');
      assert.equal(seen.headers.authorization, 'Bearer sk-provider');
      assert.equal(seen.headers['x-hc-helper'], undefined);
      assert.equal(seen.headers.origin, undefined);
    });

    test('binary answers arrive intact and errors keep their status', async () => {
      const audio = await call(target('/audio'), { method: 'POST', body: '{}' });
      assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
      assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [0xff, 0xfb, 0x00, 0x01, 0x80, 0x7f]);
      const missing = await call(target('/missing'));
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('x-hc-proxy-error'), null);
    });

    test('unreachable hosts and other schemes are the proxy own errors', async () => {
      const down = await call(`/proxy?url=${encodeURIComponent('http://127.0.0.1:9/v1/models')}`);
      assert.equal(down.status, 502);
      assert.equal(down.headers.get('x-hc-proxy-error'), '1');
      assert.match((await down.json()).error.message, /Could not reach 127\.0\.0\.1:9/);
      const file = await call(`/proxy?url=${encodeURIComponent('file:///etc/passwd')}`);
      assert.equal(file.status, 400);
      assert.equal((await call(`/proxy?url=${encodeURIComponent('http://u:p@127.0.0.1:1/')}`)).status, 400);
    });
  });
});
