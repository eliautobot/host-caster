import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSecret } from '../src/routes/secrets.js';
import { localUser, makeApp } from './helpers.js';

const doc = (extra = {}) => ({
  hosts: [{ id: 'seed-host-maya', name: 'Maya', updatedAt: 1 }],
  stations: [],
  brains: [{ id: 'b1', name: 'OpenAI', kind: 'openai', apiKey: 'sk-plain', model: 'gpt-4o-mini', transport: 'server' }],
  voices: [],
  playlists: [],
  ...extra,
});

test('sync: empty doc, first push, stale rev conflict, keys moved to secrets', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  assert.equal((await app.inject({ method: 'GET', url: '/api/sync' })).statusCode, 401);

  const empty = (await call('GET', '/api/sync')).json();
  assert.equal(empty.rev, 0);
  assert.equal(empty.doc, null);

  const put = await call('PUT', '/api/sync', { rev: 0, doc: doc() });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().rev, 1);

  const got = (await call('GET', '/api/sync')).json();
  assert.equal(got.rev, 1);
  assert.equal(got.doc.hosts[0].name, 'Maya');
  assert.equal(got.doc.brains[0].apiKey, undefined, 'plain keys never stored in the doc');
  assert.equal(got.doc.brains[0].secretRef, 'brain:b1');
  assert.equal(getSecret(app, user.id, 'brain:b1'), 'sk-plain');
  assert.doesNotMatch(app.db.prepare('SELECT json FROM sync_docs').get().json, /sk-plain/);

  // a second device still at rev 0 gets 409 with the current rev
  const stale = await call('PUT', '/api/sync', { rev: 0, doc: doc({ hosts: [] }) });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'conflict');
  assert.equal(stale.json().rev, 1);

  const next = await call('PUT', '/api/sync', { rev: 1, doc: doc({ deleted: { 'hosts:old': 5 } }) });
  assert.equal(next.json().rev, 2);
  assert.deepEqual((await call('GET', '/api/sync')).json().doc.deleted, { 'hosts:old': 5 });
});

test('sync validates the doc', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  const bad = await call('PUT', '/api/sync', { rev: 0, doc: { hosts: 'nope' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'invalid_doc');
  const noId = await call('PUT', '/api/sync', { rev: 0, doc: { hosts: [{ name: 'x' }] } });
  assert.equal(noId.statusCode, 400);
});

test('sync docs are per user', async (t) => {
  const { app } = await makeApp(t);
  const a = await localUser(app, 'a@example.com');
  const b = await localUser(app, 'b@example.com');
  await a.call('PUT', '/api/sync', { rev: 0, doc: doc() });
  assert.equal((await b.call('GET', '/api/sync')).json().rev, 0);
  assert.equal((await b.call('GET', '/api/secrets/brain:b1')).statusCode, 404);
});

test('secrets: put, list with hint, never revealed in full, delete; bound to the user', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  assert.equal((await call('PUT', '/api/secrets/voice:el', { value: 'el-abcdefghijk' })).statusCode, 200);
  assert.equal((await call('PUT', '/api/secrets/bad ref', { value: 'x' })).statusCode, 400);
  assert.equal((await call('PUT', '/api/secrets/x', { value: '' })).statusCode, 400);
  const list = (await call('GET', '/api/secrets')).json().secrets;
  assert.deepEqual(list.map((s) => [s.ref, s.hint]), [['voice:el', 'el-…hijk']]);
  const one = (await call('GET', '/api/secrets/voice:el')).json();
  assert.equal(one.hint, 'el-…hijk');
  assert.equal(one.value, undefined, 'the full key never goes back to a client');
  assert.doesNotMatch(JSON.stringify(one), /abcdefg/);
  // sealed with the user id as AAD: moving the row to another user makes it unreadable
  const row = app.db.prepare('SELECT value_enc FROM secrets').get();
  assert.throws(() => app.sealer.open(row.value_enc, `someone-else:voice:el`));
  assert.equal(app.sealer.open(row.value_enc, `${user.id}:voice:el`), 'el-abcdefghijk');
  assert.equal((await call('DELETE', '/api/secrets/voice:el')).statusCode, 204);
  assert.equal((await call('GET', '/api/secrets/voice:el')).statusCode, 404);
});

test('sync: hosts on the built-in brain get none (scripted fallback), on push and once for stored docs', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  const legacy = doc({
    hosts: [
      { id: 'h1', name: 'Maya', brainId: 'builtin', updatedAt: 1 },
      { id: 'h2', name: 'Theo', brainId: 'old', updatedAt: 1 },
      { id: 'h3', name: 'Ava', brainId: 'b1', updatedAt: 1 },
    ],
    brains: [
      { id: 'b1', name: 'OpenAI', kind: 'openai', model: 'gpt-4o-mini', transport: 'server' },
      { id: 'old', name: 'Built-in host', kind: 'builtin', model: 'builtin', transport: 'device' },
    ],
  });
  // an older app pushes it: stored without the built-in brain
  assert.equal((await call('PUT', '/api/sync', { rev: 0, doc: legacy })).statusCode, 200);
  const got = (await call('GET', '/api/sync')).json().doc;
  assert.deepEqual(got.hosts.map((h) => h.brainId), [null, null, 'b1']);
  assert.deepEqual(got.brains.map((b) => b.id), ['b1']);

  // a doc stored before this version: migration 5 rewrites it once with a new rev
  const { migrateBuiltinBrains, withoutBuiltinBrain } = await import('../src/routes/syncDoc.js');
  app.db.prepare('UPDATE sync_docs SET json = ?, rev = 7 WHERE user_id = ?').run(JSON.stringify(legacy), user.id);
  assert.equal(migrateBuiltinBrains(app.db, 5), 1);
  const after = (await call('GET', '/api/sync')).json();
  assert.equal(after.rev, 8, 'devices pull the clean doc');
  assert.deepEqual(after.doc.hosts.map((h) => h.brainId), [null, null, 'b1']);
  assert.equal(migrateBuiltinBrains(app.db, 6), 0, 'nothing left to move');
  const clean = (await call('GET', '/api/sync')).json().doc;
  assert.equal(withoutBuiltinBrain(clean), clean, 'a clean doc is returned as is');
  assert.ok(app.db.prepare('SELECT 1 FROM migrations WHERE id = 5').get(), 'migration 5 recorded');
});
