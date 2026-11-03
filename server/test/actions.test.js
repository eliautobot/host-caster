// The actions engine end to end against the stand-in Google: propose -> confirm (one-time token) -> execute -> undo,
// for each type; the token binding; one execution however many devices confirm; caps; scopes; history; sealing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../src/crypto.js';
import { FX_CAL } from './fake-providers.js';
import { dayFromNow, googleUser, seeded, setup, sleep, timedEvent, writesTo } from './actions-helpers.js';
import { oauth } from './helpers.js';

const ME = 'me@example.com';

test('actions: calendar.add proposes in plain words, runs once with a one-time token (no guests, no emails), undo deletes it', async (t) => {
  const { app, store, propose, confirm, execute, call } = await setup(t);
  const p = await propose('calendar.add', timedEvent(26, { title: '  Dentist ', location: '12 Main St' }), { said: 'put the dentist on my calendar', tz: 'America/New_York' });
  assert.equal(p.statusCode, 201, p.body);
  const a = p.json().action;
  assert.equal(a.status, 'proposed');
  assert.equal(a.level, 2);
  assert.equal(a.origin, 'call-in');
  assert.equal(a.payload.title, 'Dentist', 'trimmed');
  assert.match(a.summary, /^Add "Dentist" to your Google Calendar on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, from \d{1,2}(:\d\d)? (AM|PM) to \d{1,2}(:\d\d)? (AM|PM), at 12 Main St\. No one is invited\.$/);
  assert.equal(a.undoable, false);
  assert.ok(a.expiresAt - a.createdAt >= 9 * 60_000, 'proposal lives 10 minutes');
  assert.match(a.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(store.state.writes.length, 0, 'proposing writes nothing to Google');

  const c = await confirm(a);
  assert.equal(c.statusCode, 200, c.body);
  const { token } = c.json();
  assert.ok(token && token.length >= 40);
  assert.equal(c.json().action.status, 'confirmed');
  assert.equal(c.json().action.confirmedVia, 'tap');
  // only the token's sha256 is kept, the words and payload are sealed
  const row = app.db.prepare('SELECT * FROM actions WHERE id = ?').get(a.id);
  assert.equal(row.token_hash, sha256(token));
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes(token) && !raw.includes('Dentist') && !raw.includes('Main St'), 'nothing readable at rest');
  assert.ok(row.token_expires_at - Date.now() <= 120_000 && row.token_expires_at - Date.now() > 100_000, 'token lives 2 minutes');

  const e = await execute(a, token);
  assert.equal(e.statusCode, 200, e.body);
  const done = e.json().action;
  assert.equal(done.status, 'done');
  assert.equal(done.undoable, true);
  assert.equal(done.result.eventId, `hc${a.id.replace(/-/g, '')}`, 'the id chosen from the action id');
  assert.match(done.result.link, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
  const inserts = writesTo(store, 'POST', /\/calendar\/v3\/calendars\/primary\/events$/);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].query.sendUpdates, 'none');
  assert.deepEqual(Object.keys(inserts[0].body).sort(), ['end', 'id', 'location', 'start', 'summary']);
  assert.match(inserts[0].body.id, /^[a-v0-9]{5,1024}$/, 'base32hex');
  assert.equal(inserts[0].body.start.timeZone, 'America/New_York');
  assert.equal(store.state.inserts.events, 1);

  // the token is spent; another confirm hands back the action without a new token
  const again = await execute(a, token);
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error.code, 'token_used');
  assert.equal(again.json().action.status, 'done', 'the answer carries the current action');
  const c2 = await confirm(a);
  assert.equal(c2.statusCode, 200);
  assert.equal(c2.json().token, undefined);
  assert.equal(c2.json().action.status, 'done');
  assert.equal(store.state.inserts.events, 1);

  const u = await call('POST', `/api/actions/${a.id}/undo`, {});
  assert.equal(u.statusCode, 200, u.body);
  assert.equal(u.json().action.status, 'undone');
  assert.ok(u.json().action.undoneAt);
  assert.equal(u.json().action.undoable, false);
  const ev = store.state.events.find((x) => x.id === done.result.eventId);
  assert.equal(ev.status, 'cancelled');
  const u2 = await call('POST', `/api/actions/${a.id}/undo`, {});
  assert.equal(u2.json().action.status, 'undone', 'undo is idempotent');
  const deletes = writesTo(store, 'DELETE', /\/events\//);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].query.sendUpdates, 'none');
  // GET shows it as cancelled (like Google)
  assert.equal((await call('GET', `/api/actions/${a.id}`)).json().action.status, 'undone');
});

test('actions: an all-day calendar.add sends dates (end exclusive)', async (t) => {
  const { store, run } = await setup(t);
  const start = dayFromNow(3);
  const end = dayFromNow(5);
  const done = await run('calendar.add', { title: 'Beach trip', allDay: true, start, end, timeZone: 'America/New_York' });
  assert.equal(done.status, 'done');
  assert.match(done.summary, /^Add "Beach trip" to your Google Calendar from .+ to .+, all day\. No one is invited\.$/);
  const ins = writesTo(store, 'POST', /\/events$/)[0].body;
  assert.deepEqual([ins.start, ins.end], [{ date: start }, { date: end }]);
});

test('actions: task.add, task.complete and task.edit run in Google Tasks and undo exactly', async (t) => {
  const { store, propose, run, call } = await setup(t);
  const due = dayFromNow(4);
  // task.add with a due day: Google keeps it as midnight UTC
  const added = await run('task.add', { title: 'Call the bank', notes: 'About the card', due });
  assert.equal(added.status, 'done');
  assert.match(added.summary, /^Add "Call the bank" to your Google Tasks, due [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/);
  const task = store.state.tasks.find((x) => x.id === added.result.taskId);
  assert.equal(task.due, `${due}T00:00:00.000Z`);
  assert.equal(task.status, 'needsAction');
  assert.equal(added.result.listId, 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', 'the real list id (from the selfLink), not @default');
  assert.match(added.result.link, /^https:\/\/tasks\.google\.com\/task\//);
  assert.equal((await call('POST', `/api/actions/${added.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(task.deleted, true, 'GET shows deleted:true');
  assert.equal((await call('POST', `/api/actions/${added.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(writesTo(store, 'DELETE', /\/tasks\//).length, 1, 'one delete');

  // task.add to another list names it
  const home = await propose('task.add', { title: 'Fix the gate', listId: 'SG9tZUxpc3RmaXh0dXJlMDE' });
  assert.equal(home.statusCode, 201, home.body);
  assert.equal(home.json().action.summary, 'Add "Fix the gate" to your "Home" list in Google Tasks.');
  const noList = await propose('task.add', { title: 'Fix the gate', listId: 'nosuchlist' });
  assert.equal(noList.statusCode, 400);
  assert.deepEqual([noList.json().error.code, noList.json().error.field], ['invalid_action', 'listId']);

  // task.complete: the task must exist with that title
  const quotes = seeded(store, 'Send the three vendor quotes to Dana');
  const wrongTitle = await propose('task.complete', { listId: quotes.listId, taskId: quotes.id, title: 'Send the quotes' });
  assert.equal(wrongTitle.statusCode, 400);
  assert.equal(wrongTitle.json().error.field, 'title');
  const missing = await propose('task.complete', { listId: quotes.listId, taskId: 'bm9TdWNoVGFzazAwMDAwMA', title: 'x' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.field, 'taskId');
  const completed = await run('task.complete', { listId: quotes.listId, taskId: quotes.id, title: 'send the three vendor quotes to dana ' });
  assert.equal(completed.summary, 'Mark "send the three vendor quotes to dana" as done in your Google Tasks.');
  assert.equal(quotes.status, 'completed');
  assert.ok(Date.parse(quotes.completed) > Date.now() - 60_000);
  const doneAgain = await propose('task.complete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title });
  assert.equal(doneAgain.statusCode, 400, 'already done');
  assert.equal((await call('POST', `/api/actions/${completed.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(quotes.status, 'needsAction');
  assert.equal(quotes.completed, undefined);

  // task.edit: new title, no due date; undo restores both
  const draft = seeded(store, 'Review the Q4 budget draft');
  const before = { title: draft.title, due: draft.due, notes: draft.notes };
  const edited = await run('task.edit', { listId: draft.listId, taskId: draft.id, title: 'Review the final Q4 budget', due: null, notes: 'Bring the quotes' });
  assert.equal(edited.summary, 'Change "Review the Q4 budget draft" in your Google Tasks: rename it "Review the final Q4 budget", remove its due date and replace its notes.');
  assert.deepEqual([draft.title, draft.due, draft.notes], ['Review the final Q4 budget', undefined, 'Bring the quotes']);
  assert.equal((await call('POST', `/api/actions/${edited.id}/undo`, {})).json().action.status, 'undone');
  assert.deepEqual({ title: draft.title, due: draft.due, notes: draft.notes }, before);
  const emptyEdit = await propose('task.edit', { listId: draft.listId, taskId: draft.id });
  assert.equal(emptyEdit.statusCode, 400);
});

test('actions: invite.respond changes only the listener answer (others untouched), undo puts it back; own/not invited/cancelled/past refused', async (t) => {
  const { store, propose, confirm, execute, call } = await setup(t);
  const ev = store.state.events.find((e) => e.id === FX_CAL.invited.id);
  const othersBefore = structuredClone(ev.attendees.filter((a) => !a.self));
  const p = await propose('invite.respond', { eventId: FX_CAL.invited.id, response: 'accepted', note: 'See you there' }, { tz: 'America/New_York' });
  assert.equal(p.statusCode, 201, p.body);
  const a = p.json().action;
  assert.equal(a.level, 3);
  assert.equal(a.payload.calendarId, 'primary');
  assert.equal(a.others, 'Dana Reyes, the organizer, will see your answer.');
  assert.match(a.summary, /^Answer yes to "HC fixture: Q4 budget review" on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, at \d{1,2}(:\d\d)? (AM|PM)\. Your note: "See you there"\. Dana Reyes, the organizer, will see your answer\.$/);
  const c = await confirm(a, { via: 'call-in' });
  const e = await execute(a, c.json().token);
  assert.equal(e.json().action.status, 'done', e.body);
  const self = ev.attendees.find((x) => x.self);
  assert.deepEqual([self.email, self.responseStatus, self.comment], [ME, 'accepted', 'See you there']);
  assert.deepEqual(ev.attendees.filter((x) => !x.self), othersBefore, 'every other guest exactly as before');
  const patch = writesTo(store, 'PATCH', /\/events\//);
  assert.equal(patch.length, 1);
  assert.deepEqual(Object.keys(patch[0].body), ['attendees'], 'only the guest list goes back');
  assert.equal(patch[0].query.sendUpdates, undefined, "Google's default for answers");
  assert.equal(patch[0].body.attendees.length, ev.attendees.length);

  assert.equal((await call('POST', `/api/actions/${a.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(ev.attendees.find((x) => x.self).responseStatus, 'needsAction');
  assert.equal(ev.attendees.find((x) => x.self).comment, undefined);
  assert.deepEqual(ev.attendees.filter((x) => !x.self), othersBefore);

  for (const [id, why] of [
    ['myownevent0001', /own event/],
    ['notinvited00001', /not invited/],
    ['cancelledinvite01', /cancelled/],
    ['pastinvite0001', /over/],
    ['nosuchevent0001', /not in your calendar/],
  ]) {
    const r = await propose('invite.respond', { eventId: id, response: 'declined' });
    assert.equal(r.statusCode, 400, `${id}: ${r.body}`);
    assert.equal(r.json().error.field, 'eventId');
    assert.match(r.json().error.message, why);
  }

  // cancelled after the listener said yes but before it ran: nothing is sent
  const p2 = (await propose('invite.respond', { eventId: FX_CAL.invited.id, response: 'declined' })).json().action;
  const tok = (await confirm(p2)).json().token;
  ev.status = 'cancelled';
  const late = (await execute(p2, tok)).json().action;
  assert.equal(late.status, 'failed');
  assert.equal(late.error.code, 'event_changed');
  assert.equal(late.error.message, 'That event was cancelled, so your answer was not sent.');
  assert.equal(writesTo(store, 'PATCH', /\/events\//).length, 2, 'only the first answer and its undo');
});

test('actions: invite.respond on a big meeting (guests left out by Google) sends only the listener entry back', async (t) => {
  const { store, run, call } = await setup(t);
  const ev = store.state.events.find((e) => e.id === FX_CAL.invited.id);
  ev.attendeesOmitted = true;
  const before = structuredClone(ev.attendees.filter((a) => !a.self));
  const done = await run('invite.respond', { eventId: ev.id, response: 'declined' });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  const patch = writesTo(store, 'PATCH', /\/events\//)[0].body;
  assert.equal(patch.attendeesOmitted, true);
  assert.deepEqual(patch.attendees.map((a) => [a.email, a.responseStatus]), [[ME, 'declined']]);
  assert.deepEqual(ev.attendees.filter((a) => !a.self), before, 'nobody dropped');
  assert.equal((await call('POST', `/api/actions/${done.id}/undo`, {})).json().action.status, 'undone');
  assert.equal(ev.attendees.find((a) => a.self).responseStatus, 'needsAction');
  assert.equal(ev.attendees.length, before.length + 1);
});

test('actions: the token is bound to the payload, the action, the user and the clock', async (t) => {
  const { app, fake, store, propose, confirm, execute, call } = await setup(t, { env: { ACTIONS_TOKEN_TTL_MS: '300', ACTIONS_PROPOSAL_TTL_MS: '600' } });
  const a = (await propose('calendar.add', timedEvent(30))).json().action;
  // confirm with another payload's hash
  const wrong = await confirm(a, { hash: sha256('{"type":"calendar.add","payload":{}}') });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().error.code, 'payload_changed');
  assert.equal((await confirm(a, { via: 'nope' })).statusCode, 400);
  const { token } = (await confirm(a)).json();
  // a changed payload at execute: refused, nothing done, the token stays good for the real one
  const changed = await execute(a, token, { ...a.payload, title: 'Dentist and lunch' });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'payload_changed');
  const smuggled = await execute(a, token, { ...a.payload, attendees: [{ email: 'x@y.test' }] });
  assert.equal(smuggled.statusCode, 409);
  assert.equal((await execute(a, token, null)).statusCode, 409);
  const bad = await execute(a, 'not-the-token');
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'token_invalid');
  assert.equal(bad.json().action.status, 'confirmed');
  assert.equal(store.state.inserts.events, 0);
  // the same payload in another key order / with spaces trimmed is the same payload
  const reordered = Object.fromEntries(Object.entries({ ...a.payload, title: ` ${a.payload.title} ` }).reverse());
  const ok = await execute(a, token, reordered);
  assert.equal(ok.json().action.status, 'done', ok.body);

  // another user: the action does not exist for them; a token never crosses users
  const otto = await googleUser(app, 'otto');
  for (const [m, u, body] of [
    ['GET', `/api/actions/${a.id}`],
    ['POST', `/api/actions/${a.id}/confirm`, { payloadHash: a.payloadHash, via: 'tap' }],
    ['POST', `/api/actions/${a.id}/execute`, { token, payload: a.payload }],
    ['POST', `/api/actions/${a.id}/cancel`, {}],
    ['POST', `/api/actions/${a.id}/undo`, {}],
  ]) {
    const r = await otto.call(m, u, body);
    assert.equal(r.statusCode, 404, `${m} ${u}`);
    assert.equal(r.json().error.code, 'not_found');
  }
  const b = (await otto.propose('calendar.add', timedEvent(31))).json().action;
  await otto.confirm(b);
  const cross = await otto.execute(b, token);
  assert.equal(cross.statusCode, 401, 'gina token on otto action');
  assert.equal((await otto.call('GET', '/api/actions')).json().actions.length, 1, 'otto sees only his own');
  assert.equal((await call('GET', '/api/actions/not-an-id')).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/actions' })).statusCode, 401, 'signed in only');
  assert.equal((await app.inject({ method: 'POST', url: '/api/actions/propose', payload: {} })).statusCode, 403, 'CSRF header');

  // the token runs out after its TTL (300 ms here): refused, nothing done; confirming again gives a fresh one
  const x = (await propose('calendar.add', timedEvent(32))).json().action;
  const t1 = (await confirm(x)).json().token;
  await sleep(350);
  const expired = await execute(x, t1);
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().error.code, 'token_expired');
  const t2 = (await confirm(x)).json().token;
  assert.ok(t2 && t2 !== t1, 'a new token after the old one ran out unused');
  assert.equal((await execute(x, t1)).json().error.code, 'token_invalid', 'the old one is gone');
  assert.equal((await execute(x, t2)).json().action.status, 'done');

  // the proposal runs out after its TTL (600 ms here)
  const y = (await propose('calendar.add', timedEvent(33))).json().action;
  await sleep(650);
  assert.equal((await call('GET', `/api/actions/${y.id}`)).json().action.status, 'expired');
  const late = await confirm(y);
  assert.equal(late.statusCode, 410);
  assert.equal(late.json().error.code, 'action_expired');

  // cancel: idempotent; a confirmed-then-cancelled token is dead
  const z = (await propose('calendar.add', timedEvent(34))).json().action;
  const tz = (await confirm(z)).json().token;
  assert.equal((await call('POST', `/api/actions/${z.id}/cancel`, {})).json().action.status, 'cancelled');
  assert.equal((await call('POST', `/api/actions/${z.id}/cancel`, {})).json().action.status, 'cancelled');
  assert.equal((await execute(z, tz)).json().error.code, 'token_invalid');
  assert.equal((await confirm(z)).statusCode, 410);
  // a done action cannot be cancelled (it stays done)
  assert.equal((await call('POST', `/api/actions/${a.id}/cancel`, {})).json().action.status, 'done');
  assert.equal(store.state.inserts.events, 2, 'only a and x ran');
  assert.ok(fake.log.length > 0);
});

test('actions: one execution however many confirm and execute at once; same ref = same proposal', async (t) => {
  const { store, propose, confirm, execute, call } = await setup(t);
  const first = await propose('task.add', { title: 'Water the plants' }, { ref: 'call:abc:1' });
  assert.equal(first.statusCode, 201);
  const same = await propose('task.add', { title: 'Something else' }, { ref: 'call:abc:1' });
  assert.equal(same.statusCode, 200);
  assert.equal(same.json().action.id, first.json().action.id);
  const raced = await Promise.all(Array.from({ length: 5 }, () => propose('task.add', { title: 'Water the plants' }, { ref: 'call:race' })));
  assert.equal(new Set(raced.map((r) => r.json().action.id)).size, 1, 'concurrent same ref: one proposal');
  assert.equal((await call('GET', '/api/actions/status')).json().usedProposals, 2);
  const a = first.json().action;

  // two "devices" confirm at once: one token
  const both = await Promise.all([confirm(a, { via: 'call-in' }), confirm(a, { via: 'tap' })]);
  assert.deepEqual(both.map((r) => r.statusCode), [200, 200]);
  const tokens = both.map((r) => r.json().token).filter(Boolean);
  assert.equal(tokens.length, 1);

  // 20 executes with that token at once: one runs, the rest are told it was used
  const runs = await Promise.all(Array.from({ length: 20 }, () => execute(a, tokens[0])));
  const codes = runs.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(','));
  assert.equal(codes.filter((c) => c === 401).length, 19);
  assert.ok(runs.filter((r) => r.statusCode === 401).every((r) => r.json().error.code === 'token_used'));
  assert.equal(store.state.inserts.tasks, 1);

  // 20 devices each confirm then execute whatever token they got
  const b = (await propose('task.add', { title: 'Feed the cat' })).json().action;
  const devices = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const c = await confirm(b, { via: i % 2 ? 'tap' : 'call-in' });
      return c.json().token ? (await execute(b, c.json().token)).json().action : c.json().action;
    }),
  );
  assert.ok(devices.some((d) => d.status === 'done'));
  assert.equal(store.state.inserts.tasks, 2, 'one task for 20 devices');
  assert.equal(store.state.tasks.filter((x) => x.title === 'Feed the cat').length, 1);
});

test('actions: Google 429/500/timeouts are retried without a duplicate; honest failure after 3 tries', async (t) => {
  const { store, run, call } = await setup(t);
  const POST_EVENT = '^POST /gapi/calendar/v3/calendars/primary/events$';
  const POST_TASK = '^POST /gapi/tasks/v1/lists/[^/]+/tasks$';

  // 429 twice, then fine
  store.addFault({ match: POST_EVENT, status: 429, count: 2 });
  let done = await run('calendar.add', timedEvent(40, { title: 'After two 429s' }));
  assert.equal(done.status, 'done');
  assert.equal(store.state.events.filter((e) => e.summary === 'After two 429s').length, 1);

  // it landed but the answer was lost (connection cut): the retry gets 409 and adopts it
  store.addFault({ match: POST_EVENT, drop: true });
  done = await run('calendar.add', timedEvent(41, { title: 'Answer lost' }));
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(store.state.events.filter((e) => e.summary === 'Answer lost').length, 1, 'no duplicate');
  assert.equal(done.result.eventId, `hc${done.id.replace(/-/g, '')}`);

  // it landed but Google answered too late (timeout 400 ms here)
  store.addFault({ match: POST_EVENT, delayMs: 900 });
  done = await run('calendar.add', timedEvent(42, { title: 'Slow answer' }));
  assert.equal(done.status, 'done');
  assert.equal(store.state.events.filter((e) => e.summary === 'Slow answer').length, 1, 'no duplicate');

  // 500 three times: failed, honest words, nothing added
  store.addFault({ match: POST_EVENT, status: 500, count: 3 });
  const failed = await run('calendar.add', timedEvent(43, { title: 'Never made' }));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: 'google_unavailable', message: 'Google Calendar did not answer, so nothing was added.' });
  assert.equal(failed.undoable, false);
  assert.equal(store.state.events.filter((e) => e.summary === 'Never made').length, 0);

  // 429 three times: "asked to slow down"
  store.addFault({ match: POST_EVENT, status: 429, count: 3 });
  const busy = await run('calendar.add', timedEvent(44, { title: 'Busy' }));
  assert.equal(busy.error.code, 'google_busy');
  assert.match(busy.error.message, /^Google Calendar asked to slow down, so nothing was added\./);

  // cut three times before Google saw it, and the check after fails too: "cannot tell"
  store.addFault({ match: POST_EVENT, drop: 'before', count: 3 });
  store.addFault({ match: '^GET /gapi/calendar/v3/calendars/primary/events/hc', status: 503 });
  const unsure = await run('calendar.add', timedEvent(45, { title: 'Unsure' }));
  assert.equal(unsure.error.code, 'unknown_outcome');
  assert.match(unsure.error.message, /cannot tell whether it went through\. Check your calendar before asking again\.$/);

  // tasks: an insert whose answer was lost is found (same title + due) instead of inserted again
  store.clearFaults();
  store.addFault({ match: POST_TASK, drop: true });
  done = await run('task.add', { title: 'Lost answers', due: dayFromNow(2) });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(store.state.tasks.filter((x) => x.title === 'Lost answers').length, 1, 'one task');
  const looked = store.state.requests.filter((r) => r.method === 'GET' && /\/tasks$/.test(r.path));
  assert.equal(looked.length, 1, 'it looked before inserting again');
  assert.equal(writesTo(store, 'POST', /\/tasks$/).length, 1, 'and did not insert again');
  // ... even when the look itself fails once: it looks again on the third try
  store.addFault({ match: POST_TASK, drop: true });
  store.addFault({ match: '^GET /gapi/tasks/v1/lists/[^/]+/tasks$', status: 500 });
  done = await run('task.add', { title: 'Lost twice' });
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(store.state.tasks.filter((x) => x.title === 'Lost twice').length, 1, 'one task');
  // an answer too slow (it landed): adopted; a task with the same title from days ago is not (only since this try)
  store.clearFaults();
  const old = { ...seeded(store, 'Book the team offsite room'), id: 'b2xkU2xvd1Rhc2swMDAwMA', title: 'Slow task', updated: new Date(Date.now() - 2 * 86_400_000).toISOString() };
  store.state.tasks.push(old);
  store.addFault({ match: POST_TASK, delayMs: 900 });
  done = await run('task.add', { title: 'Slow task' });
  assert.equal(done.status, 'done');
  assert.notEqual(done.result.taskId, old.id, 'not the old one');
  assert.equal(store.state.tasks.filter((x) => x.title === 'Slow task').length, 2, 'the old one and exactly one new');
  store.clearFaults();
  store.addFault({ match: POST_TASK, status: 503, count: 3 });
  const noTask = await run('task.add', { title: 'No task' });
  assert.deepEqual(noTask.error, { code: 'google_unavailable', message: 'Google Tasks did not answer, so nothing was added.' });
  assert.equal(store.state.tasks.filter((x) => x.title === 'No task').length, 0);

  // a patch that fails once is simply sent again
  store.clearFaults();
  const quotes = seeded(store, 'Send the three vendor quotes to Dana');
  store.addFault({ match: '^PATCH /gapi/tasks/', status: 500 });
  done = await run('task.complete', { listId: quotes.listId, taskId: quotes.id, title: quotes.title });
  assert.equal(done.status, 'done');
  store.addFault({ match: '^PATCH /gapi/calendar/', status: 502 });
  done = await run('invite.respond', { eventId: FX_CAL.invited.id, response: 'tentative' });
  assert.equal(done.status, 'done');
  assert.equal(store.state.events.find((e) => e.id === FX_CAL.invited.id).attendees.find((a) => a.self).responseStatus, 'tentative');

  // undo retried too; when it cannot, the action stays done with the error and can be tried again
  const undoMe = await run('calendar.add', timedEvent(46, { title: 'Undo me' }));
  store.addFault({ match: '^DELETE /gapi/calendar/', status: 500, count: 3 });
  const uf = (await call('POST', `/api/actions/${undoMe.id}/undo`, {})).json().action;
  assert.equal(uf.status, 'done');
  assert.equal(uf.undoable, true);
  assert.deepEqual(uf.error, { code: 'undo_failed', message: 'Google Calendar did not answer, so the event is still in your calendar.' });
  const ok = (await call('POST', `/api/actions/${undoMe.id}/undo`, {})).json().action;
  assert.equal(ok.status, 'undone');
  assert.equal(ok.error, undefined);

  // no duplicates anywhere
  const ids = store.state.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('actions: Retry-After (capped at 3 s) and the default pauses (0.4 s, 1.2 s)', async (t) => {
  const { store, run } = await setup(t, { env: { ACTIONS_BACKOFF_MS: '' } });
  store.addFault({ match: '^POST /gapi/calendar/', status: 429, count: 2 });
  let t0 = Date.now();
  let done = await run('calendar.add', timedEvent(50));
  const plain = Date.now() - t0;
  assert.equal(done.status, 'done');
  assert.ok(plain >= 1550 && plain < 4000, `0.4 s + 1.2 s, took ${plain} ms`);
  store.addFault({ match: '^POST /gapi/calendar/', status: 429, retryAfter: 9 });
  t0 = Date.now();
  done = await run('calendar.add', timedEvent(51));
  const capped = Date.now() - t0;
  assert.equal(done.status, 'done');
  assert.ok(capped >= 2900 && capped < 4500, `Retry-After 9 s capped at 3 s, took ${capped} ms`);
  t.diagnostic(`backoff 429x2: ${plain} ms; Retry-After 9 (cap 3 s): ${capped} ms`);
});

test('actions: daily caps (executions and proposals) and the status', async (t) => {
  const { propose, run, confirm, call } = await setup(t, { env: { ACTIONS_PER_DAY: '2', ACTION_PROPOSALS_PER_DAY: '4' } });
  let st = (await call('GET', '/api/actions/status')).json();
  assert.deepEqual(st, { calendarWrite: true, tasks: true, caps: { perDay: 2, proposalsPerDay: 4 }, used: 0, usedProposals: 0 });
  await run('task.add', { title: 'One' });
  await run('task.add', { title: 'Two' });
  const third = (await propose('task.add', { title: 'Three' })).json().action;
  const c = await confirm(third);
  assert.equal(c.statusCode, 429);
  assert.equal(c.json().error.code, 'actions_limit');
  assert.equal((await propose('task.add', { title: 'Four' })).statusCode, 201);
  const fifth = await propose('task.add', { title: 'Five' });
  assert.equal(fifth.statusCode, 429);
  assert.equal(fifth.json().error.code, 'proposals_limit');
  st = (await call('GET', '/api/actions/status')).json();
  assert.deepEqual([st.used, st.usedProposals], [2, 4]);
});

test('actions: without the write scopes they are refused (scope_missing + service); turning the switch on asks Google for them', async (t) => {
  const { app, fake, propose, call, cookie } = await setup(t, { scopes: ['calendar', 'gmail'] });
  const cal = await propose('calendar.add', timedEvent(26));
  assert.equal(cal.statusCode, 403);
  assert.deepEqual(cal.json().error, { code: 'scope_missing', message: 'Reconnect Google to allow this', service: 'calendarEvents' });
  const task = await propose('task.add', { title: 'x' });
  assert.equal(task.json().error.service, 'tasks');
  const inv = await propose('invite.respond', { eventId: FX_CAL.invited.id, response: 'accepted' });
  assert.equal(inv.json().error.service, 'calendarEvents');
  const tasks = await call('GET', '/api/google/tasks');
  assert.equal(tasks.statusCode, 403);
  assert.equal(tasks.json().error.code, 'scope_missing');
  assert.equal(tasks.json().error.service, 'tasks');
  assert.deepEqual((await call('GET', '/api/actions/status')).json().calendarWrite, false);
  assert.equal(fake.writes.state.writes.length, 0);

  // the switch: incremental consent for exactly the new scopes, the old ones kept
  const { start, cb } = await oauth(app, 'google', {
    query: '?scopes=calendarEvents,tasks&link=1',
    code: 'gina|openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks|1',
    headers: { cookie },
  });
  const asked = start.searchParams.get('scope').split(' ');
  assert.ok(asked.includes('https://www.googleapis.com/auth/calendar.events') && asked.includes('https://www.googleapis.com/auth/tasks'));
  assert.ok(!asked.includes('https://www.googleapis.com/auth/calendar'), 'never full calendar access');
  assert.equal(start.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(cb.statusCode, 302);
  const st = (await call('GET', '/api/actions/status')).json();
  assert.deepEqual([st.calendarWrite, st.tasks], [true, true]);
  const g = (await call('GET', '/api/google/status')).json();
  assert.ok(g.scopes.includes('calendar') && g.scopes.includes('calendarEvents') && g.scopes.includes('tasks'));
  assert.equal((await propose('calendar.add', timedEvent(26))).statusCode, 201);
});

test('actions: history newest first, by status; NEVER types refused; nothing readable at rest', async (t) => {
  const { app, propose, run, call } = await setup(t);
  const a = await run('task.add', { title: 'First thing' });
  const b = (await propose('task.add', { title: 'Second thing' })).json().action;
  await call('POST', `/api/actions/${b.id}/cancel`, {});
  const c = (await propose('calendar.add', timedEvent(28, { title: 'Third thing' }))).json().action;
  const all = (await call('GET', '/api/actions?limit=50')).json().actions;
  assert.deepEqual(all.map((x) => x.id), [c.id, b.id, a.id]);
  assert.deepEqual((await call('GET', '/api/actions?status=cancelled')).json().actions.map((x) => x.id), [b.id]);
  assert.deepEqual((await call('GET', '/api/actions?status=done')).json().actions.map((x) => x.id), [a.id]);
  assert.equal((await call('GET', '/api/actions?limit=1')).json().actions.length, 1);
  assert.equal((await call('GET', '/api/actions?status=bogus')).json().actions.length, 3, 'an unknown status filter is ignored');

  for (const type of ['mail.forward', 'mail.delete', 'mail.send', 'email.draft', 'payment.send', 'purchase', 'calendar.invite', 'calendar.edit', 'calendar.share', 'event.update', 'share', 'contacts.share', 'list.add', 'reminder.add', 'notion.write', '', 'Calendar.Add', 'calendar.add ', '__proto__', 'constructor', 'toString', 123, null, ['calendar.add'], { type: 'calendar.add' }]) {
    const r = await propose(type, { title: 'x', to: 'boss@x.test' });
    assert.equal(r.statusCode, 400, `${JSON.stringify(type)}: ${r.body}`);
    assert.equal(r.json().error.code, 'action_not_allowed', JSON.stringify(type));
  }
  assert.equal((await propose('task.add', { title: 'x' }, { origin: 'heads-up' })).json().error.field, 'origin', 'no background origin');
  const rows = app.db.prepare('SELECT * FROM actions').all();
  assert.equal(rows.length, 3, 'refused ones leave nothing');
  const raw = JSON.stringify(rows);
  for (const word of ['First thing', 'Second thing', 'Third thing']) assert.ok(!raw.includes(word), word);
  // the 90-day prune and old rows
  app.db.prepare('UPDATE actions SET created_at = ? WHERE id = ?').run(Date.now() - 91 * 86_400_000, a.id);
  const { prune } = await import('../src/actions/store.js');
  prune(app, Date.now() + 2 * 3_600_000);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM actions').get().n, 2);
  // an undo after 7 days is refused (Google is the place to change it then)
  const d = await run('task.add', { title: 'Old one' });
  app.db.prepare('UPDATE actions SET executed_at = ? WHERE id = ?').run(Date.now() - 8 * 86_400_000, d.id);
  assert.equal((await call('GET', `/api/actions/${d.id}`)).json().action.undoable, false);
  const late = await call('POST', `/api/actions/${d.id}/undo`, {});
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error.code, 'not_undoable');
  // a cancelled one has nothing to undo
  assert.equal((await call('POST', `/api/actions/${b.id}/undo`, {})).statusCode, 409);
});

test('actions: an execution cut short by a restart is reported as unknown, never run again', async (t) => {
  const { app, propose, confirm, call } = await setup(t);
  const a = (await propose('task.add', { title: 'Mid-way' })).json().action;
  await confirm(a);
  app.db.prepare("UPDATE actions SET status = 'executing', token_used_at = ? WHERE id = ?").run(Date.now() - 6 * 60_000, a.id);
  const got = (await call('GET', `/api/actions/${a.id}`)).json().action;
  assert.equal(got.status, 'failed');
  assert.equal(got.error.code, 'unknown_outcome');
});
