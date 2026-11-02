// Load on the actions engine (run with STRESS=1): many devices confirming at once, many actions at once with lost
// answers, tokens running out under load, rapid proposals, a long task list. Prints timings as diagnostics.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TASK_LISTS } from './fake-google-store.js';
import { setup, sleep, timedEvent } from './actions-helpers.js';

const skip = process.env.STRESS === '1' ? false : 'set STRESS=1 to run the load tests';
const ms = (t0) => Date.now() - t0;
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((arr.length * p) / 100))];

test('stress: 20 devices confirm and execute each of 10 actions at once: 10 executions', { skip }, async (t) => {
  const { store, propose, confirm, execute } = await setup(t);
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const a = (await propose('calendar.add', timedEvent(30 + i, { title: `Crowd ${i}` }))).json().action;
    const out = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = await confirm(a);
        return c.json().token ? (await execute(a, c.json().token)).statusCode : 'no-token';
      }),
    );
    assert.equal(out.filter((x) => x === 200).length, 1, out.join(','));
  }
  assert.equal(store.state.inserts.events, 10);
  t.diagnostic(`10 actions x 20 concurrent devices: ${ms(t0)} ms`);
});

test('stress: 20 different actions at once, 10 of their answers lost: 20 events, no duplicate', { skip }, async (t) => {
  const { store, propose, confirm, execute } = await setup(t);
  store.addFault({ match: '^POST /gapi/calendar/v3/calendars/primary/events$', drop: true, count: 10 });
  const times = [];
  const t0 = Date.now();
  const done = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const s = Date.now();
      const a = (await propose('calendar.add', timedEvent(40 + i, { title: `Parallel ${i}` }))).json().action;
      const c = await confirm(a);
      const e = (await execute(a, c.json().token)).json().action;
      times.push(Date.now() - s);
      return e;
    }),
  );
  assert.ok(done.every((a) => a.status === 'done'), JSON.stringify(done.filter((a) => a.status !== 'done').map((a) => a.error)));
  assert.equal(store.state.events.filter((e) => /^Parallel /.test(e.summary)).length, 20);
  assert.equal(new Set(store.state.events.map((e) => e.id)).size, store.state.events.length);
  t.diagnostic(`20 parallel (10 lost answers): total ${ms(t0)} ms, p50 ${pct(times, 50)} ms, max ${Math.max(...times)} ms`);
});

test('stress: tokens running out under load: the late ones are refused, nothing runs twice or late', { skip }, async (t) => {
  const { store, propose, confirm, execute } = await setup(t, { env: { ACTIONS_TOKEN_TTL_MS: '400' } });
  // Google slow for some: makes the load uneven
  store.addFault({ match: '^POST /gapi/tasks/', status: 429, count: 8 });
  const actions = [];
  for (let i = 0; i < 40; i++) actions.push((await propose('task.add', { title: `Load ${i}` })).json().action);
  const t0 = Date.now();
  const tokens = await Promise.all(actions.map(async (a) => (await confirm(a)).json().token));
  const results = await Promise.all(
    actions.map(async (a, i) => {
      if (i % 2) await sleep(700); // past the 400 ms token
      const r = await execute(a, tokens[i]);
      return { i, code: r.statusCode, status: r.json().action?.status, error: r.json().error?.code };
    }),
  );
  const early = results.filter((r) => r.i % 2 === 0);
  const late = results.filter((r) => r.i % 2 === 1);
  assert.ok(early.every((r) => r.code === 200 && r.status === 'done'), JSON.stringify(early.filter((r) => r.status !== 'done')));
  assert.ok(late.every((r) => r.code === 401 && r.error === 'token_expired'), JSON.stringify(late.filter((r) => r.error !== 'token_expired')));
  const made = store.state.tasks.filter((x) => /^Load \d+$/.test(x.title));
  assert.equal(made.length, 20);
  assert.equal(new Set(made.map((x) => x.title)).size, 20, 'no duplicates');
  t.diagnostic(`40 confirmations, 20 executed in time and 20 refused as expired: ${ms(t0)} ms`);
});

test('stress: 50 proposals at once, and 50 with the same ref', { skip }, async (t) => {
  const { propose, call } = await setup(t);
  let t0 = Date.now();
  const many = await Promise.all(Array.from({ length: 50 }, (_, i) => propose('task.add', { title: `Rapid ${i}` })));
  const rapid = ms(t0);
  assert.ok(many.every((r) => r.statusCode === 201));
  assert.equal(new Set(many.map((r) => r.json().action.id)).size, 50);
  t0 = Date.now();
  const same = await Promise.all(Array.from({ length: 50 }, () => propose('task.add', { title: 'Once' }, { ref: 'call:rapid:1' })));
  const sameMs = ms(t0);
  assert.equal(new Set(same.map((r) => r.json().action.id)).size, 1);
  assert.equal((await call('GET', '/api/actions?limit=200')).json().actions.length, 51);
  t.diagnostic(`50 proposals at once: ${rapid} ms; 50 with one ref: ${sameMs} ms`);
});

test('stress: 300 tasks listed from Google', { skip }, async (t) => {
  const { call, store } = await setup(t);
  for (let i = 0; i < 300; i++) {
    store.state.tasks.push({ ...store.state.tasks[1], id: `c3RyZXNz${String(i).padStart(14, '0')}`, title: `Stress task ${i}`, listId: TASK_LISTS[1].id });
  }
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const r = (await call('GET', '/api/google/tasks')).json();
    runs.push(ms(t0));
    assert.equal(r.tasks.filter((x) => x.listId === TASK_LISTS[1].id).length, 300);
  }
  t.diagnostic(`GET /api/google/tasks with 300+ tasks: p50 ${pct(runs, 50)} ms, max ${Math.max(...runs)} ms`);
});
