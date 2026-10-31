import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHost, checkUrl, classify, embeddedV4, makePolicy } from '../src/net/egress.js';
import { userRequest } from '../src/net/http.js';
import { startFakeProviders } from './fake-providers.js';
import { localUser, makeApp } from './helpers.js';

const strict = makePolicy();
const resolverOf = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host];
};

test('classify: public, private and always-blocked addresses', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(classify(a), 'public', a);
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.10', '169.254.10.10', '100.90.10.20', '::1', 'fd12::1', 'fe80::1']) {
    assert.equal(classify(a), 'private', a);
  }
  for (const a of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fd00:ec2::254', '::', 'ff02::1']) {
    assert.equal(classify(a), 'blocked', a);
  }
  assert.equal(embeddedV4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(embeddedV4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedV4('2002:c0a8:0101::1'), '192.168.1.1');
  assert.equal(classify('::ffff:10.0.0.1'), 'private');
  assert.equal(classify('64:ff9b::169.254.169.254'), 'blocked');
});

test('checkUrl: schemes, credentials, names resolving inward, mixed answers, metadata names', async () => {
  const resolver = resolverOf({
    'feeds.example.com': ['93.184.216.34'],
    'rebind.example.com': ['127.0.0.1'],
    'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
    'v6loop.example.com': ['::1'],
  });
  assert.equal((await checkUrl('https://feeds.example.com/a.rss', strict, resolver)).address, '93.184.216.34');
  assert.equal((await checkUrl('http://8.8.8.8/', strict, resolver)).address, '8.8.8.8');
  await assert.rejects(checkUrl('ftp://feeds.example.com', strict, resolver), { code: 'invalid_url' });
  await assert.rejects(checkUrl('https://u:p@feeds.example.com', strict, resolver), { code: 'invalid_url' });
  await assert.rejects(checkUrl('not a url', strict, resolver), { code: 'invalid_url' });
  for (const u of ['http://rebind.example.com', 'http://mixed.example.com', 'http://v6loop.example.com', 'http://[::1]:8080/', 'http://192.168.0.2/', 'http://localhost.']) {
    await assert.rejects(checkUrl(u, strict, async (h) => (h === 'localhost' ? ['127.0.0.1'] : resolver(h))), { code: 'blocked_address' }, u);
  }
  await assert.rejects(checkUrl('http://metadata.google.internal/', makePolicy({ allowPrivate: true }), resolver), { code: 'blocked_address' });
  await assert.rejects(checkUrl('http://169.254.169.254/latest', makePolicy({ allowPrivate: true }), resolver), { code: 'blocked_address' });
  await assert.rejects(checkUrl('http://nowhere.example.com', strict, resolver), { code: 'dns_failed' });
});

test('policy: ALLOW_PRIVATE_FETCH and FETCH_ALLOW entries (CIDR, IP, host, host:port)', async () => {
  const resolver = resolverOf({ 'ollama.lan': ['192.168.1.20'], 'nas.lan': ['192.168.1.30'] });
  assert.ok(await checkUrl('http://100.90.10.20:11434/v1', makePolicy({ allow: ['100.64.0.0/10'] }), resolver));
  assert.ok(await checkUrl('http://192.168.1.20/', makePolicy({ allow: ['192.168.1.20'] }), resolver));
  assert.ok(await checkUrl('http://ollama.lan:11434/', makePolicy({ allow: ['ollama.lan:11434'] }), resolver));
  await assert.rejects(checkUrl('http://ollama.lan:22/', makePolicy({ allow: ['ollama.lan:11434'] }), resolver), { code: 'blocked_address' });
  await assert.rejects(checkUrl('http://nas.lan/', makePolicy({ allow: ['ollama.lan'] }), resolver), { code: 'blocked_address' });
  assert.ok(await checkUrl('http://nas.lan/', makePolicy({ allowPrivate: true }), resolver));
  assert.ok(await checkHost('imap.lan', 993, makePolicy({ allowPrivate: true }), async () => ['10.0.0.2']));
  assert.throws(() => makePolicy({ allow: ['bad entry!'] }));
});

test('pinned dial: connects to the validated address while Host keeps the name', async (t) => {
  const fake = await startFakeProviders(t);
  const ctx = { egress: makePolicy({ allow: ['127.0.0.1'] }), resolver: resolverOf({ 'feeds.example.test': ['127.0.0.1'] }) };
  const res = await userRequest(ctx, `http://feeds.example.test:${fake.port}/echo-host`);
  assert.equal(res.body.toString(), `host=feeds.example.test:${fake.port}`);
  // without the allow the real client refuses before dialling
  const before = fake.log.length;
  await assert.rejects(userRequest({ egress: strict, resolver: ctx.resolver }, `http://feeds.example.test:${fake.port}/echo-host`), { code: 'blocked_address' });
  assert.equal(fake.log.length, before);
  // a redirect to a private address is re-checked and refused
  const allowLoopbackOnly = { egress: makePolicy({ allow: ['127.0.0.1'] }), resolver: ctx.resolver };
  await assert.rejects(userRequest(allowLoopbackOnly, `${fake.base}/to-private`), { code: 'blocked_address' });
  await assert.rejects(userRequest(allowLoopbackOnly, `${fake.base}/big`, { maxBytes: 1024 }), { code: 'too_large' });
});

test('POST /api/fetch-text: signed-in only, fetches feeds, refuses private targets', async (t) => {
  const fake = await startFakeProviders(t);
  const resolver = resolverOf({ 'cal.example.test': ['127.0.0.1'], 'evil.example.test': ['10.0.0.9'] });
  const { app } = await makeApp(t, { FETCH_ALLOW: 'cal.example.test' }, { resolver });
  assert.equal((await app.inject({ method: 'POST', url: '/api/fetch-text', headers: { 'x-hostcaster': '1' }, payload: { url: 'http://x' } })).statusCode, 401);
  const { call } = await localUser(app);
  const ok = await call('POST', '/api/fetch-text', { url: `http://cal.example.test:${fake.port}/feed.ics` });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.json().text, /BEGIN:VCALENDAR/);
  assert.match(ok.json().contentType, /text\/calendar/);
  const evil = await call('POST', '/api/fetch-text', { url: 'http://evil.example.test/' });
  assert.equal(evil.statusCode, 400);
  assert.equal(evil.json().error.code, 'blocked_address');
  assert.match(evil.json().error.message, /private network/);
  const meta = await call('POST', '/api/fetch-text', { url: 'http://169.254.169.254/latest/meta-data' });
  assert.equal(meta.json().error.code, 'blocked_address');
});
