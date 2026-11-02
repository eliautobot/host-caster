// The reads round 4 adds: the listener's Google Tasks, "have I ever written to this sender", and the list (tracker)
// synced sealed like the memories.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localUser, makeApp } from './helpers.js';
import { TASK_LISTS } from './fake-google-store.js';
import { setup } from './actions-helpers.js';

test('google tasks: open ones and those done in the last 3 days, every list, the shape the app reads', async (t) => {
  const { call, store } = await setup(t);
  const res = await call('GET', '/api/google/tasks');
  assert.equal(res.statusCode, 200, res.body);
  const { lists, tasks } = res.json();
  assert.deepEqual(lists, TASK_LISTS);
  const titles = tasks.map((x) => x.title);
  assert.ok(titles.includes('Send the three vendor quotes to Dana'));
  assert.ok(titles.includes('Call the plumber'), 'done yesterday (hidden in Google) is kept');
  assert.ok(!titles.includes('File the September expenses'), 'done 20 days ago is not');
  assert.equal(tasks.filter((x) => x.status === 'needsAction').length, 5);
  const quotes = tasks.find((x) => x.title === 'Send the three vendor quotes to Dana');
  assert.deepEqual(Object.keys(quotes).sort(), ['due', 'id', 'link', 'listId', 'listTitle', 'notes', 'status', 'title', 'updated']);
  assert.match(quotes.due, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(quotes.listTitle, 'My Tasks');
  assert.match(quotes.link, /^https:\/\/tasks\.google\.com\/task\//);
  const plumber = tasks.find((x) => x.title === 'Call the plumber');
  assert.equal(plumber.status, 'completed');
  assert.ok(plumber.completed);
  assert.equal(plumber.listTitle, 'Home');
  // deleted ones and untitled ones are left out
  store.state.tasks.push({ ...store.state.tasks[0], id: 'ZGVsZXRlZDAwMDAwMDAwMA', title: 'Gone', deleted: true }, { ...store.state.tasks[0], id: 'dW50aXRsZWQwMDAwMDAwMA', title: '  ' });
  const again = (await call('GET', '/api/google/tasks')).json().tasks;
  assert.equal(again.length, tasks.length);
  // what the server asked Google for
  const asked = store.state.requests.filter((r) => /\/tasks\/v1\/lists\/[^/]+\/tasks$/.test(r.path));
  assert.ok(asked.length >= 2);
});

test('google tasks: 300 per list (pages of 100), the rest left out', async (t) => {
  const { call, store } = await setup(t);
  const [mine] = TASK_LISTS;
  for (let i = 0; i < 340; i++) {
    store.state.tasks.push({ ...store.state.tasks[1], id: `bWFueVRhc2s${String(i).padStart(11, '0')}`, title: `Bulk task ${i}`, listId: mine.id });
  }
  const t0 = Date.now();
  const { tasks } = (await call('GET', '/api/google/tasks')).json();
  const ms = Date.now() - t0;
  assert.equal(tasks.filter((x) => x.listId === mine.id).length, 300);
  assert.ok(tasks.some((x) => x.listId === TASK_LISTS[1].id), 'the other list too');
  t.diagnostic(`300+ tasks listed in ${ms} ms`);
});

test('known senders: "in:sent to:" per address, cached; without Gmail an empty answer', async (t) => {
  const { call, store } = await setup(t);
  const r = await call('POST', '/api/google/known-senders', { emails: ['Dana@Example.com', 'stranger@phish.test', 'not an email', 42, 'dana@example.com'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { known: { 'dana@example.com': true, 'stranger@phish.test': false } });
  const sent = store.state.requests.filter((x) => x.path === '/gapi/gmail/v1/users/me/messages');
  assert.equal(sent.length, 2);
  // cached: no new Gmail calls
  assert.deepEqual((await call('POST', '/api/google/known-senders', { emails: ['dana@example.com', 'stranger@phish.test'] })).json().known, { 'dana@example.com': true, 'stranger@phish.test': false });
  assert.equal(store.state.requests.filter((x) => x.path === '/gapi/gmail/v1/users/me/messages').length, 2);
  assert.equal((await call('POST', '/api/google/known-senders', { emails: Array.from({ length: 41 }, (_, i) => `a${i}@x.test`) })).statusCode, 400);
  assert.equal((await call('POST', '/api/google/known-senders', { emails: 'dana@example.com' })).statusCode, 400);
  assert.deepEqual((await call('POST', '/api/google/known-senders', { emails: [] })).json(), { known: {} });
  // a listener without Gmail (or without Google): {} (the app treats unknown as new)
  const { app: plain } = await makeApp(t);
  const local = await localUser(plain, 'nogoogle@example.com');
  assert.deepEqual((await local.call('POST', '/api/google/known-senders', { emails: ['dana@example.com'] })).json(), { known: {} });
  const { call: noGmail } = await setup(t, { scopes: ['calendar'] });
  assert.deepEqual((await noGmail('POST', '/api/google/known-senders', { emails: ['dana@example.com'] })).json(), { known: {} });
});

test('sync: the list (tracker) is sealed at rest like the memories, kept when an older app pushes without it', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  const base = { hosts: [], stations: [], brains: [], voices: [], playlists: [] };
  const item = {
    id: 'tr_1',
    what: 'Send Dana the three vendor quotes',
    kind: 'todo',
    due: '2026-11-05',
    source: { type: 'email', id: '19a1b2c3d4e5f607', label: 'Email from Dana Reyes', from: 'Dana Reyes', address: 'dana@example.com' },
    status: 'open',
    key: 'email:19a1b2c3d4e5f607:quotes',
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal((await call('PUT', '/api/sync', { rev: 0, doc: { ...base, tracker: [item] } })).statusCode, 200);
  const raw = app.db.prepare('SELECT json FROM sync_docs WHERE user_id = ?').get(user.id).json;
  assert.ok(!raw.includes('Dana') && !raw.includes('quotes'), 'nothing readable at rest');
  assert.match(JSON.parse(raw).trackerSealed, /^v1\./);
  const got = (await call('GET', '/api/sync')).json();
  assert.deepEqual(got.doc.tracker, [item]);
  assert.equal(got.doc.trackerSealed, undefined);
  assert.deepEqual(got.doc.memories, [], 'memories still there (empty)');
  // an older app knows nothing of the list: its push keeps it
  assert.equal((await call('PUT', '/api/sync', { rev: 1, doc: base })).statusCode, 200);
  assert.equal((await call('GET', '/api/sync')).json().doc.tracker[0].id, 'tr_1');
  // memories and the list side by side, each sealed on its own
  const card = { id: 'm_1', text: 'Your sister Ana visits soon', kind: 'plans', createdAt: 1, updatedAt: 1 };
  assert.equal((await call('PUT', '/api/sync', { rev: 2, doc: { ...base, memories: [card] } })).statusCode, 200);
  const both = (await call('GET', '/api/sync')).json().doc;
  assert.deepEqual([both.memories.length, both.tracker.length], [1, 1]);
  // emptied: stored as nothing
  assert.equal((await call('PUT', '/api/sync', { rev: 3, doc: { ...base, tracker: [] } })).statusCode, 200);
  assert.equal(JSON.parse(app.db.prepare('SELECT json FROM sync_docs WHERE user_id = ?').get(user.id).json).trackerSealed, undefined);
  assert.deepEqual((await call('GET', '/api/sync')).json().doc.tracker, []);
  // bad shapes refused; a planted sealed blob is dropped
  assert.equal((await call('PUT', '/api/sync', { rev: 4, doc: { ...base, tracker: 'x' } })).statusCode, 400);
  assert.equal((await call('PUT', '/api/sync', { rev: 4, doc: { ...base, tracker: [{ id: 'x', what: 'y'.repeat(500) }] } })).statusCode, 400);
  assert.equal((await call('PUT', '/api/sync', { rev: 4, doc: { ...base, tracker: [{ what: 'no id' }] } })).statusCode, 400);
  assert.equal((await call('PUT', '/api/sync', { rev: 4, doc: { ...base, tracker: Array.from({ length: 1501 }, (_, i) => ({ id: `t${i}`, what: 'x' })) } })).statusCode, 400);
  assert.equal((await call('PUT', '/api/sync', { rev: 4, doc: { ...base, trackerSealed: 'v1.a.b.c' } })).statusCode, 200);
  assert.deepEqual((await call('GET', '/api/sync')).json().doc.tracker, []);
  // another user cannot open it (bound to the user)
  const other = await localUser(app, 'other@example.com');
  assert.equal((await other.call('PUT', '/api/sync', { rev: 0, doc: { ...base, tracker: [item] } })).statusCode, 200);
  const sealed = JSON.parse(app.db.prepare('SELECT json FROM sync_docs WHERE user_id = ?').get(other.user.id).json).trackerSealed;
  assert.throws(() => app.sealer.open(sealed, `${user.id}:sync:tracker`));
});
