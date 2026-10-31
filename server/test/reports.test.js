// Reported AI breaks: POST /api/reports (both editions), validation, per-account daily limit, isolation, deletion
// with the account. The online edition's email copy and admin count: online-reports.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORT_LIMITS, parseReport } from '../src/routes/reports.js';
import { localUser, makeApp } from './helpers.js';

const report = (extra = {}) => ({
  kind: 'break',
  stationName: 'Morning Drive',
  at: Date.now() - 60_000,
  lines: [
    { hostName: 'Maya', text: 'Good morning, here is the weather.' },
    { hostName: 'Jules', text: 'And a song you will love.' },
  ],
  ...extra,
});

const rowsOf = (app, userId) => app.db.prepare('SELECT * FROM reports WHERE user_id = ? ORDER BY created_at').all(userId);

test('reports: a signed-in account reports a break; it is stored with its lines and note', async (t) => {
  const { app } = await makeApp(t);
  const u = await localUser(app);
  const res = await u.call('POST', '/api/reports', report({ note: '  Rude about my town  ' }));
  assert.equal(res.statusCode, 201, res.body);
  const { id, createdAt } = res.json();
  assert.ok(id && createdAt);
  const rows = rowsOf(app, u.user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].kind, 'break');
  const json = JSON.parse(rows[0].json);
  assert.equal(json.stationName, 'Morning Drive');
  assert.equal(json.note, 'Rude about my town');
  assert.deepEqual(json.lines.map((l) => l.hostName), ['Maya', 'Jules']);
  // no station, no note, no host name: still fine
  const bare = await u.call('POST', '/api/reports', { kind: 'break', at: Date.now(), lines: [{ text: 'One line' }] });
  assert.equal(bare.statusCode, 201, bare.body);
});

test('reports: signed out is refused, and a cookie write needs the X-HostCaster header', async (t) => {
  const { app } = await makeApp(t);
  const anon = await app.inject({ method: 'POST', url: '/api/reports', headers: { 'x-hostcaster': '1' }, payload: report() });
  assert.equal(anon.statusCode, 401);
  const u = await localUser(app);
  const csrf = await app.inject({ method: 'POST', url: '/api/reports', headers: { cookie: u.cookie }, payload: report() });
  assert.equal(csrf.statusCode, 403);
  assert.equal(csrf.json().error.code, 'csrf');
  assert.equal(rowsOf(app, u.user.id).length, 0);
});

test('reports: bodies are checked (kind, time, lines, sizes)', async (t) => {
  const { app } = await makeApp(t);
  const u = await localUser(app);
  const many = Array.from({ length: REPORT_LIMITS.maxLines + 1 }, (_, i) => ({ hostName: 'Maya', text: `line ${i}` }));
  const cases = [
    [{ ...report(), kind: 'song' }, 400],
    [{ ...report(), at: 'yesterday' }, 400],
    [{ ...report(), at: Date.now() + 3 * 24 * 60 * 60 * 1000 }, 400],
    [{ ...report(), lines: [] }, 400],
    [{ ...report(), lines: 'hello' }, 400],
    [{ ...report(), lines: many }, 400],
    [{ ...report(), lines: [{ hostName: 'Maya', text: '   ' }] }, 400],
    [{ ...report(), lines: [{ hostName: 7, text: 'hi' }] }, 400],
    [{ ...report(), lines: ['just text'] }, 400],
    [{ ...report(), stationName: 'x'.repeat(121) }, 400],
    [{ ...report(), note: 'x'.repeat(2001) }, 400],
    // each line fits, together they are over 8 KB
    [{ ...report(), lines: Array.from({ length: 5 }, () => ({ hostName: 'Maya', text: 'y'.repeat(1900) })) }, 413],
  ];
  for (const [body, status] of cases) {
    const res = await u.call('POST', '/api/reports', body);
    assert.equal(res.statusCode, status, `${JSON.stringify(body).slice(0, 80)} -> ${res.body}`);
  }
  // far too big for the route at all
  const huge = await u.call('POST', '/api/reports', { ...report(), note: 'z'.repeat(100_000) });
  assert.equal(huge.statusCode, 413);
  assert.equal(rowsOf(app, u.user.id).length, 0);
  assert.throws(() => parseReport(null), /Send a report/);
});

test('reports: 20 a day per account; another account is not affected; deleted with the account', async (t) => {
  const { app } = await makeApp(t);
  const a = await localUser(app, 'a@example.com');
  const b = await localUser(app, 'b@example.com');
  for (let i = 0; i < REPORT_LIMITS.perDay; i++) assert.equal((await a.call('POST', '/api/reports', report())).statusCode, 201);
  const over = await a.call('POST', '/api/reports', report());
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error.code, 'rate_limited');
  assert.equal((await b.call('POST', '/api/reports', report({ note: 'mine' }))).statusCode, 201);
  assert.equal(rowsOf(app, a.user.id).length, REPORT_LIMITS.perDay);
  assert.equal(rowsOf(app, b.user.id).length, 1);
  // a day later A may report again
  app.db.prepare('UPDATE reports SET created_at = created_at - ? WHERE user_id = ?').run(25 * 60 * 60 * 1000, a.user.id);
  assert.equal((await a.call('POST', '/api/reports', report())).statusCode, 201);
  // deleting A removes A's reports only
  assert.equal((await a.call('DELETE', '/api/me')).statusCode, 204);
  assert.equal(rowsOf(app, a.user.id).length, 0);
  assert.equal(rowsOf(app, b.user.id).length, 1);
});
