// The action types the hosts' agent tools added (docs/AGENT.md): Google Tasks delete and move, Calendar update and
// delete (level 3 with a read-back when Google tells guests), and who may confirm (never an AI app; "auto" only for
// level 2). Against the stand-in Google, like actions.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../src/actions/registry.js';
import { TASK_LISTS } from './fake-google-store.js';
import { seeded, setup, writesTo } from './actions-helpers.js';

const HOUR = 3_600_000;
const at = (ms) => ({ dateTime: new Date(ms).toISOString().replace('.000Z', 'Z'), timeZone: 'America/New_York' });

/** an event in the listener's calendar: their own (with or without guests) or someone else's */
function seedEvent(store, id, { title = 'Dentist', guests = [], own = true, hours = 30 } = {}) {
  const start = Math.ceil((Date.now() + hours * HOUR) / HOUR) * HOUR;
  const me = { email: 'me@example.com', self: true, ...(own ? { organizer: true } : {}), responseStatus: 'accepted' };
  const ev = {
    kind: 'calendar#event',
    id,
    status: 'confirmed',
    summary: title,
    location: 'Main St',
    organizer: own ? { email: 'me@example.com', self: true } : { email: 'dana@example.com', displayName: 'Dana Reyes' },
    start: at(start),
    end: at(start + HOUR),
    ...(guests.length || !own ? { attendees: [me, ...guests.map((email) => ({ email, responseStatus: 'needsAction' }))] } : {}),
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  };
  store.state.events.push(ev);
  return ev;
}

test('agent actions: the new schemas are strict', () => {
  assert.throws(() => normalize('task.delete', { listId: 'a', taskId: 'b' }), /title/);
  assert.throws(() => normalize('task.delete', { listId: 'a', taskId: 'b', title: 'x', extra: 1 }), /Unknown field/);
  assert.throws(() => normalize('task.move', { listId: 'a', taskId: 'b', title: 'x', toListId: 'a' }), /already in that list/);
  assert.throws(() => normalize('calendar.update', { eventId: 'abc' }), /Say what to change/);
  assert.throws(() => normalize('calendar.update', { eventId: 'abc', start: '2026-11-05T10:00:00Z' }), /together/);
  assert.throws(() => normalize('calendar.update', { eventId: 'abc', title: 'x', attendees: [] }), /Unknown field/);
  assert.throws(() => normalize('calendar.update', { eventId: 'bad id!', title: 'x' }), /eventId|valid/);
  assert.throws(() => normalize('calendar.delete', { eventId: 'abc' }), /title/);
  assert.throws(() => normalize('calendar.share', { eventId: 'abc' }), /cannot do/);
  assert.deepEqual(normalize('calendar.update', { eventId: 'abc', location: null }), { calendarId: 'primary', eventId: 'abc', location: null });
  const past = { eventId: 'abc', allDay: false, start: '2020-01-01T10:00:00Z', end: '2020-01-01T11:00:00Z', timeZone: 'UTC' };
  assert.throws(() => normalize('calendar.update', past, { now: Date.now() }), /already passed/);
});

test('agent actions: task.delete reads back, deletes once, undo puts back a copy', async (t) => {
  const { store, propose, run, call } = await setup(t);
  const quotes = seeded(store, 'Send the three vendor quotes to Dana');
  const wrong = await propose('task.delete', { listId: quotes.listId, taskId: quotes.id, title: 'Something else' });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error.field, 'title');
  const p = await propose('task.delete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title });
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().action.summary, 'Delete "Send the three vendor quotes to Dana" from your Google Tasks.');
  assert.equal(p.json().action.level, 2);
  const done = await run('task.delete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title }, { ref: 'del-1' });
  assert.equal(done.status, 'done');
  assert.equal(quotes.deleted, true);
  assert.equal(done.undoable, true);
  const before = store.state.tasks.length;
  const u = await call('POST', `/api/actions/${done.id}/undo`, {});
  assert.equal(u.json().action.status, 'undone', u.body);
  const copy = store.state.tasks.at(-1);
  assert.equal(store.state.tasks.length, before + 1);
  assert.equal(copy.title, quotes.title);
  assert.equal(copy.due, quotes.due);
  assert.equal(copy.listId, quotes.listId);
  // gone already: honest, nothing to delete
  const again = await propose('task.delete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title });
  assert.equal(again.statusCode, 400);
});

test('agent actions: task.move names both lists, moves, undo moves it back', async (t) => {
  const { store, propose, run, call } = await setup(t);
  const [mine, home] = TASK_LISTS;
  const quotes = seeded(store, 'Send the three vendor quotes to Dana');
  assert.equal(quotes.listId, mine.id);
  const p = await propose('task.move', { listId: mine.id, taskId: quotes.id, title: quotes.title, toListId: home.id });
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().action.summary, `Move "${quotes.title}" from your "${mine.title}" list to your "${home.title}" list in Google Tasks.`);
  const nowhere = await propose('task.move', { listId: mine.id, taskId: quotes.id, title: quotes.title, toListId: 'bm9TdWNoTGlzdA' });
  assert.equal(nowhere.statusCode, 400);
  assert.equal(nowhere.json().error.field, 'toListId');
  const done = await run('task.move', { listId: mine.id, taskId: quotes.id, title: quotes.title, toListId: home.id }, { ref: 'mv-1' });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(quotes.listId, home.id);
  assert.equal(done.result.listId, home.id);
  assert.equal((await call('POST', `/api/actions/${done.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(quotes.listId, mine.id);
});

test('agent actions: calendar.update of an own event without guests tells no one; undo sets it back', async (t) => {
  const { store, propose, run, call } = await setup(t);
  const ev = seedEvent(store, 'ownevent00001');
  const oldStart = ev.start.dateTime;
  const start = Date.parse(oldStart) + 24 * HOUR;
  const payload = { eventId: ev.id, title: 'Dentist (moved)', allDay: false, start: at(start).dateTime, end: at(start + HOUR).dateTime, timeZone: 'America/New_York' };
  const p = await propose('calendar.update', payload, { tz: 'America/New_York' });
  assert.equal(p.statusCode, 201, p.body);
  const a = p.json().action;
  assert.equal(a.level, 2);
  assert.match(a.summary, /^Change "Dentist" on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, at .+ on your Google Calendar: move it to (?!on )[A-Z].+ and rename it "Dentist \(moved\)"\.$/);
  assert.ok(!/guest/.test(a.summary));
  const done = await run('calendar.update', payload, { tz: 'America/New_York', ref: 'up-1' });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(ev.summary, 'Dentist (moved)');
  assert.equal(Date.parse(ev.start.dateTime), start);
  const patch = writesTo(store, 'PATCH', /ownevent00001/).at(-1);
  assert.equal(patch.query.sendUpdates, 'none');
  assert.equal((await call('POST', `/api/actions/${done.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(ev.summary, 'Dentist');
  assert.equal(ev.start.dateTime, oldStart);
});

test('agent actions: an event with guests is level 3 (the read-back counts them, Google tells them); someone else\'s is refused', async (t) => {
  const { store, propose, confirm, execute, run } = await setup(t);
  const ev = seedEvent(store, 'teamevent0001', { title: 'Team lunch', guests: ['dana@example.com', 'priya.shah@example.com', 'room@resource.calendar.google.com'] });
  ev.attendees.at(-1).resource = true;
  const p = await propose('calendar.update', { eventId: ev.id, location: 'Cafe Uno' }, { tz: 'America/New_York' });
  assert.equal(p.statusCode, 201, p.body);
  const a = p.json().action;
  assert.equal(a.level, 3);
  assert.match(a.summary, /set the place to Cafe Uno\. Google tells your 2 guests \(dana@example\.com and priya\.shah@example\.com\) about the change\.$/);
  assert.equal(a.others, 'This tells your 2 guests (dana@example.com and priya.shah@example.com).');
  // "allowed without asking" never covers what other people see
  const auto = await confirm(a, { via: 'auto' });
  assert.equal(auto.statusCode, 400, auto.body);
  const c = await confirm(a, { via: 'call' });
  assert.equal(c.statusCode, 200, c.body);
  const e = await execute(a, c.json().token);
  assert.equal(e.json().action.status, 'done', e.body);
  assert.equal(writesTo(store, 'PATCH', /teamevent0001/).at(-1).query.sendUpdates, 'all');

  const del = await run('calendar.delete', { eventId: ev.id, title: 'Team lunch' }, { tz: 'America/New_York', ref: 'del-team' });
  assert.equal(del.status, 'done', JSON.stringify(del.error));
  assert.equal(del.level, 3);
  assert.match(del.summary, /^Delete "Team lunch" on .+ from your Google Calendar\. Google tells your 2 guests \(dana@example\.com and priya\.shah@example\.com\) that it is cancelled\.$/);
  assert.equal(del.undoable, false, 'Google already told the guests: no honest undo');
  assert.equal(ev.status, 'cancelled');
  assert.equal(writesTo(store, 'DELETE', /teamevent0001/).at(-1).query.sendUpdates, 'all');

  const theirs = seedEvent(store, 'theirevent001', { title: 'Board meeting', own: false });
  for (const [type, payload] of [
    ['calendar.update', { eventId: theirs.id, title: 'Mine now' }],
    ['calendar.delete', { eventId: theirs.id, title: 'Board meeting' }],
  ]) {
    const r = await propose(type, payload);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().error.message, /someone else's event/);
  }
});

test('agent actions: calendar.delete of an own event without guests is undone (restored)', async (t) => {
  const { store, propose, run, call } = await setup(t);
  const ev = seedEvent(store, 'soloevent0001', { title: 'Haircut' });
  const wrong = await propose('calendar.delete', { eventId: ev.id, title: 'Dentist' });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error.field, 'title');
  const done = await run('calendar.delete', { eventId: ev.id, title: 'Haircut' }, { ref: 'del-solo' });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.level, 2);
  assert.equal(ev.status, 'cancelled');
  assert.equal(writesTo(store, 'DELETE', /soloevent0001/).at(-1).query.sendUpdates, 'none');
  assert.equal(done.undoable, true);
  assert.equal((await call('POST', `/api/actions/${done.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(ev.status, 'confirmed');
});

test('agent actions: who may confirm (never an AI app; auto for level 2; call and chat are the listener)', async (t) => {
  const { store, propose, confirm, execute } = await setup(t);
  const quotes = seeded(store, 'Send the three vendor quotes to Dana');
  const p = (await propose('task.complete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title }, { origin: 'chat' })).json().action;
  assert.equal(p.origin, 'chat');
  const byApp = await confirm(p, { via: 'ai-app' });
  assert.equal(byApp.statusCode, 400);
  assert.match(byApp.json().error.message, /AI app never confirms/);
  const auto = await confirm(p, { via: 'auto' });
  assert.equal(auto.statusCode, 200, auto.body);
  assert.equal(auto.json().action.confirmedVia, 'auto');
  assert.equal((await execute(p, auto.json().token)).json().action.status, 'done');
  const bad = await propose('task.add', { title: 'x' }, { origin: 'break' });
  assert.equal(bad.statusCode, 400);
});
