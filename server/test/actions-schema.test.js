// The action schemas: every type valid and invalid, fuzzed (random keys, wrong types, huge strings, smuggled guests,
// hidden characters), the payload hash, and the plain words read back to the listener.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScopeList, shortGoogleScopes } from '../src/auth/providers.js';
import { HttpError } from '../src/errors.js';
import { TYPES, canonicalJson, describe, normalize, payloadHash, whenWords } from '../src/actions/registry.js';
import { setup, timedEvent } from './actions-helpers.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const ch = (...codes) => String.fromCodePoint(...codes);
const HIDDEN_TEST = new RegExp(`[${ch(0x200b)}${ch(0x202e)}]`);

const VALID = {
  'calendar.add': { title: 'Dentist', allDay: false, start: '2026-11-03T15:00:00-05:00', end: '2026-11-03T16:00:00-05:00', timeZone: 'America/New_York', location: '12 Main St', notes: 'Bring the card' },
  'task.add': { title: 'Send the quotes', notes: 'All three', due: '2026-11-05', listId: '@default' },
  'task.complete': { listId: 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', taskId: 'cGhyczhLeFFMclRSR2JsSQ', title: 'Send the quotes' },
  'task.edit': { listId: 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', taskId: 'cGhyczhLeFFMclRSR2JsSQ', title: 'New', due: null, notes: 'x' },
  'invite.respond': { calendarId: 'primary', eventId: 'q4review7nkl3lnqohsgg9inv', response: 'declined', note: 'Sorry, out that day' },
  'task.delete': { listId: 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', taskId: 'cGhyczhLeFFMclRSR2JsSQ', title: 'Send the quotes' },
  'task.move': { listId: 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', taskId: 'cGhyczhLeFFMclRSR2JsSQ', title: 'Send the quotes', toListId: '@default' },
  'calendar.update': { calendarId: 'primary', eventId: 'q4review7nkl3lnqohsgg9inv', title: 'Dentist', allDay: false, start: '2026-11-03T15:00:00-05:00', end: '2026-11-03T16:00:00-05:00', timeZone: 'America/New_York', location: '12 Main St' },
  'calendar.delete': { calendarId: 'primary', eventId: 'q4review7nkl3lnqohsgg9inv', title: 'Dentist' },
  'notion.add': { kind: 'todo', text: 'Order the oat milk' },
};

function refuses(type, payload, field, msg = '') {
  try {
    normalize(type, payload, { now: NOW });
  } catch (err) {
    assert.ok(err instanceof HttpError, `${msg} HttpError`);
    assert.equal(err.statusCode, 400, msg);
    assert.equal(err.code, 'invalid_action', `${msg} ${err.message}`);
    if (field) assert.equal(err.extra?.field, field, `${msg}: ${err.message}`);
    return err;
  }
  assert.fail(`${type} accepted ${msg}: ${JSON.stringify(payload).slice(0, 200)}`);
}

test('schemas: the valid payload of each type, with defaults filled in and text cleaned', () => {
  for (const [type, p] of Object.entries(VALID)) assert.ok(normalize(type, structuredClone(p), { now: NOW }), type);
  assert.deepEqual(normalize('task.add', { title: '  Call   mom ' }), { title: 'Call   mom', listId: '@default' });
  assert.deepEqual(normalize('invite.respond', { eventId: 'abc_20261109T190000Z', response: 'tentative' }), { calendarId: 'primary', eventId: 'abc_20261109T190000Z', response: 'tentative' });
  assert.deepEqual(normalize('calendar.add', { ...VALID['calendar.add'], location: '  ', notes: '' }, { now: NOW }).location, undefined, 'empty optional text is left out');
  assert.equal(normalize('task.edit', { listId: 'L', taskId: 'T', notes: '' }).notes, null, 'empty notes clear them');
  // NFC: the same title typed two ways is the same payload (and hash)
  const a = normalize('task.add', { title: `Cafe${ch(0x301)} order` });
  const b = normalize('task.add', { title: `Caf${ch(0xe9)} order` });
  assert.equal(payloadHash('task.add', a), payloadHash('task.add', b));
  // emoji with joiners and other scripts are fine
  assert.ok(normalize('task.add', { title: `Family dinner ${ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}` }));
  assert.ok(normalize('task.add', { title: `${ch(0x5e7, 0x5e0, 0x5d4)} milk` }));
  assert.ok(normalize('task.add', { title: `${ch(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0645)}` }), 'ZWNJ in Persian');
  // notes keep their line breaks
  assert.equal(normalize('task.add', { title: 'x', notes: 'line 1\r\nline 2' }).notes, 'line 1\nline 2');
});

test('schemas: unknown keys are refused (guests, emails, ids, recurrence ... smuggled in any form)', () => {
  const smuggle = ['attendees', 'guests', 'sendUpdates', 'sendNotifications', 'id', 'recurrence', 'conferenceData', 'visibility', 'calendarId', 'organizer', 'to', 'cc', 'forward', 'amount', 'Attendees', 'attendees ', '__proto__', 'constructor', 'prototype'];
  for (const [type, p] of Object.entries(VALID)) {
    for (const key of smuggle) {
      if (type === 'invite.respond' && key === 'calendarId') continue;
      const payload = JSON.parse(JSON.stringify({ ...p, [key]: [{ email: 'boss@x.test' }] }).replace(/}$/, `,${JSON.stringify(key)}:[{"email":"boss@x.test"}]}`));
      refuses(type, payload, key, `${type}+${key}`);
    }
  }
  // __proto__ from JSON is an own key (never merged into the payload)
  const proto = JSON.parse('{"title":"x","listId":"@default","__proto__":{"attendees":[{"email":"a@b.c"}]}}');
  refuses('task.add', proto, '__proto__');
  refuses('calendar.add', [], 'payload');
  refuses('calendar.add', 'title=x', 'payload');
  refuses('task.add', null, 'payload');
});

test('schemas: wrong types, huge strings, hidden characters', () => {
  const values = [123, 0, -1, 1e309, true, false, [], ['x'], {}, { title: 'x' }, '', '   '];
  for (const [type, p] of Object.entries(VALID)) {
    for (const key of Object.keys(p)) {
      for (const v of values) {
        // allDay true/false is a valid value (it then decides how start/end are read)
        if (key === 'allDay' && typeof v === 'boolean') continue;
        const payload = { ...p, [key]: v };
        let ok = true;
        try {
          normalize(type, payload, { now: NOW });
        } catch (err) {
          ok = false;
          assert.equal(err.code, 'invalid_action', `${type}.${key}=${JSON.stringify(v)}`);
          assert.equal(err.extra.field, key, `${type}.${key}=${JSON.stringify(v)}`);
        }
        // only an empty optional text (left out) may pass with these values
        if (ok) assert.ok((v === '' || v === '   ') && ['location', 'notes', 'note', 'listId', 'calendarId'].includes(key), `${type}.${key}=${JSON.stringify(v)} passed`);
      }
    }
  }
  const caps = { 'calendar.add': { title: 120, location: 200, notes: 500 }, 'task.add': { title: 200, notes: 500 }, 'task.complete': { title: 200 }, 'task.edit': { title: 200, notes: 500 }, 'invite.respond': { note: 300 } };
  for (const [type, fields] of Object.entries(caps)) {
    for (const [key, max] of Object.entries(fields)) {
      assert.ok(normalize(type, { ...VALID[type], [key]: 'a'.repeat(max) }, { now: NOW }), `${type}.${key} at ${max}`);
      assert.match(refuses(type, { ...VALID[type], [key]: 'a'.repeat(max + 1) }, key).message, /too long/);
      refuses(type, { ...VALID[type], [key]: 'a'.repeat(1_000_000) }, key, 'a megabyte');
      // the limit counts characters, not UTF-16 units
      assert.ok(normalize(type, { ...VALID[type], [key]: ch(0x1f600).repeat(max) }, { now: NOW }), `${type}.${key} emoji`);
    }
  }
  const hidden = [0x0, 0x7, 0x1b, 0x7f, 0x85, 0xad, 0x200b, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfffb];
  for (const code of hidden) {
    refuses('task.add', { title: `Pay ${ch(code)}the bill` }, 'title', `U+${code.toString(16)}`);
    refuses('calendar.add', { ...VALID['calendar.add'], location: `Main${ch(code)} St` }, 'location', `U+${code.toString(16)}`);
    refuses('invite.respond', { ...VALID['invite.respond'], note: `ok${ch(code)}` }, 'note', `U+${code.toString(16)}`);
  }
  // a title with nothing readable (only joiners/marks) is as good as empty
  refuses('task.add', { title: ch(0x200d, 0x200c) }, 'title');
  refuses('task.add', { title: ch(0x301, 0x301) }, 'title');
  for (const br of ['\n', '\r', '\t', ch(0x2028), ch(0x2029)]) refuses('task.add', { title: `a${br}b` }, 'title', 'one line');
  // ids are strict
  for (const bad of ['../x', 'a b', 'a/b', 'x'.repeat(201), '%2e%2e', 'abc?x=1', 'abc#', '']) {
    refuses('task.complete', { ...VALID['task.complete'], taskId: bad }, 'taskId', bad);
    refuses('task.edit', { ...VALID['task.edit'], listId: bad }, 'listId', bad);
    if (bad) refuses('invite.respond', { ...VALID['invite.respond'], eventId: bad.length > 200 ? 'x'.repeat(301) : bad }, 'eventId', bad);
  }
  for (const bad of ['../../users/me', 'other calendar', 'x@y', '@default']) refuses('invite.respond', { ...VALID['invite.respond'], calendarId: bad }, 'calendarId', bad);
  for (const bad of ['yes', 'ACCEPTED', 'needsAction', '', null, 1]) refuses('invite.respond', { ...VALID['invite.respond'], response: bad }, 'response', String(bad));
});

test('schemas: calendar.add times (offsets, past with 2 minutes grace, 24 hours, 14 days, real days, zones)', () => {
  const c = (over) => ({ ...VALID['calendar.add'], ...over });
  refuses('calendar.add', c({ start: '2026-11-03T15:00:00', end: '2026-11-03T16:00:00' }), 'start', 'no offset');
  refuses('calendar.add', c({ start: '2026-11-03 15:00:00-05:00' }), 'start', 'space');
  refuses('calendar.add', c({ start: '2026-02-30T15:00:00Z', end: '2026-02-30T16:00:00Z' }), 'start', 'no Feb 30');
  refuses('calendar.add', c({ start: '2026-11-03T25:00:00Z' }), 'start');
  refuses('calendar.add', c({ start: 1762200000000 }), 'start');
  refuses('calendar.add', c({ end: '2026-11-03T15:00:00-05:00' }), 'end', 'end = start');
  refuses('calendar.add', c({ end: '2026-11-03T14:00:00-05:00' }), 'end', 'end before start');
  refuses('calendar.add', c({ end: '2026-11-04T15:01:00-05:00' }), 'end', 'over 24 hours');
  assert.ok(normalize('calendar.add', c({ end: '2026-11-04T15:00:00-05:00' }), { now: NOW }), 'exactly 24 hours');
  // past: 1 minute ago is fine (grace), 3 minutes ago is not
  const at = (ms) => new Date(ms).toISOString();
  assert.ok(normalize('calendar.add', c({ start: at(NOW - 60_000), end: at(NOW + 3_600_000) }), { now: NOW }));
  assert.match(refuses('calendar.add', c({ start: at(NOW - 180_000), end: at(NOW + 3_600_000) }), 'start').message, /already passed/);
  refuses('calendar.add', c({ start: '2031-11-03T15:00:00Z', end: '2031-11-03T16:00:00Z' }), 'start', 'years ahead');
  // without a clock (execute) only the shape is checked
  assert.ok(normalize('calendar.add', c({ start: '2020-01-01T10:00:00Z', end: '2020-01-01T11:00:00Z' })));
  // all-day: dates, end exclusive, at most 14 days, not before today in the listener's zone
  const d = (over) => c({ allDay: true, start: '2026-11-03', end: '2026-11-04', ...over });
  assert.ok(normalize('calendar.add', d({}), { now: NOW }));
  refuses('calendar.add', d({ end: '2026-11-03' }), 'end', 'end exclusive');
  assert.ok(normalize('calendar.add', d({ end: '2026-11-17' }), { now: NOW }), '14 days');
  refuses('calendar.add', d({ end: '2026-11-18' }), 'end', '15 days');
  refuses('calendar.add', d({ start: '2026-10-31', end: '2026-11-01' }), 'start', 'yesterday');
  refuses('calendar.add', d({ start: '2026-11-03T00:00:00Z' }), 'start', 'a time on an all-day event');
  // 2026-11-01 01:00 UTC is still Oct 31 in New York: "today" there is Oct 31
  assert.ok(normalize('calendar.add', d({ start: '2026-10-31', end: '2026-11-01' }), { now: Date.parse('2026-11-01T01:00:00Z') }));
  refuses('calendar.add', c({ allDay: 'false' }), 'allDay');
  refuses('calendar.add', c({ allDay: undefined }), 'allDay');
  for (const tz of ['Mars/Olympus', 'America/New_York\n', '../etc/passwd', 'x'.repeat(65), '', 5, null, 'America/New York']) {
    refuses('calendar.add', c({ timeZone: tz }), 'timeZone', String(tz));
  }
  for (const tz of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'Etc/GMT+5']) assert.ok(normalize('calendar.add', c({ timeZone: tz }), { now: NOW }), tz);
});

test('schemas: never-allowed types', () => {
  for (const type of ['mail.forward', 'mail.delete', 'payment.send', 'purchase.make', 'calendar.invite', 'calendar.share', 'calendar.attendees', 'event.delete', 'task.share', 'drive.share', 'list.add', 'reminder.add', 'Task.Add', 'task.add\u0000', 'hasOwnProperty', '__proto__', '', undefined, null, 7, {}, []]) {
    assert.throws(() => normalize(type, { title: 'x' }), (err) => err.code === 'action_not_allowed' && err.statusCode === 400, String(type));
  }
  assert.deepEqual(Object.keys(TYPES).sort(), ['calendar.add', 'calendar.delete', 'calendar.update', 'invite.respond', 'notion.add', 'task.add', 'task.complete', 'task.delete', 'task.edit', 'task.move']);
});

/** a small deterministic random source */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test('schemas: 3000 fuzzed payloads either come back clean or are refused with a field (never anything else)', () => {
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const KEYS = ['title', 'allDay', 'start', 'end', 'timeZone', 'location', 'notes', 'due', 'listId', 'taskId', 'calendarId', 'eventId', 'response', 'note', 'attendees', 'id', 'x', '__proto__', 'sendUpdates'];
  const VALS = () => [
    'Dentist',
    '',
    ' ',
    'a'.repeat(Math.floor(rand() * 700)),
    `x${ch(0x200b)}y`,
    `x${ch(0x202e)}y`,
    'ok',
    '2026-11-03',
    '2026-11-03T15:00:00-05:00',
    '2026-11-03T16:30:00Z',
    'America/New_York',
    'accepted',
    '@default',
    'cGhyczhLeFFMclRSR2JsSQ',
    true,
    false,
    null,
    0,
    42,
    [],
    {},
    [{ email: 'a@b.c' }],
    ch(0x1f600),
  ];
  const ALLOWED = {
    'calendar.add': ['title', 'allDay', 'start', 'end', 'timeZone', 'location', 'notes'],
    'task.add': ['title', 'notes', 'due', 'listId'],
    'task.complete': ['listId', 'taskId', 'title'],
    'task.edit': ['listId', 'taskId', 'title', 'due', 'notes'],
    'invite.respond': ['calendarId', 'eventId', 'response', 'note'],
    'task.delete': ['listId', 'taskId', 'title'],
    'task.move': ['listId', 'taskId', 'title', 'toListId'],
    'calendar.update': ['calendarId', 'eventId', 'title', 'allDay', 'start', 'end', 'timeZone', 'location'],
    'calendar.delete': ['calendarId', 'eventId', 'title'],
    'notion.add': ['kind', 'text'],
  };
  let accepted = 0;
  for (let i = 0; i < 3000; i++) {
    const type = pick(Object.keys(TYPES));
    // half start from a valid payload and change a few things, half are random
    const p = rand() < 0.5 ? structuredClone(VALID[type]) : {};
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const key = rand() < 0.7 ? pick(ALLOWED[type]) : pick(KEYS);
      if (rand() < 0.15) delete p[key];
      else p[key] = pick(VALS());
    }
    let out;
    try {
      out = normalize(type, p, { now: NOW });
    } catch (err) {
      assert.ok(err instanceof HttpError && err.statusCode === 400 && err.code === 'invalid_action' && typeof err.extra?.field === 'string', `${type} ${JSON.stringify(p).slice(0, 300)} -> ${err.stack}`);
      continue;
    }
    accepted++;
    // what comes back has only the allowed keys, with the right types, and text without hidden characters
    for (const [k, v] of Object.entries(out)) {
      assert.ok(ALLOWED[type].includes(k), `${type}: ${k}`);
      assert.ok(v === null || ['string', 'boolean'].includes(typeof v), `${type}.${k}: ${typeof v}`);
      if (typeof v === 'string') assert.ok(!HIDDEN_TEST.test(v) && v === v.trim(), `${type}.${k} clean`);
    }
    assert.ok(describe(type, out, { currentTitle: 'x', title: 'Q4', organizer: 'Dana Reyes', start: NOW + 86_400_000, tz: 'UTC' }, NOW).summary.length > 10);
    assert.equal(payloadHash(type, out), payloadHash(type, normalize(type, out)), 'stable');
  }
  assert.ok(accepted > 100, `some accepted (${accepted})`);
});

test('schemas: the payload hash is canonical JSON of { type, payload }', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}');
  const p = normalize('task.add', { title: 'x', due: '2026-11-05' });
  const q = normalize('task.add', { due: '2026-11-05', listId: '@default', title: ' x ' });
  assert.equal(payloadHash('task.add', p), payloadHash('task.add', q));
  assert.notEqual(payloadHash('task.add', p), payloadHash('task.add', { ...p, due: '2026-11-06' }));
  assert.notEqual(payloadHash('task.add', p), payloadHash('task.complete', p), 'the type is part of it');
  assert.match(payloadHash('task.add', p), /^[0-9a-f]{64}$/);
});

test('words: exactly what the listener hears', () => {
  const words = (type, p, ctx = {}) => describe(type, normalize(type, p), ctx, NOW);
  assert.deepEqual(words('calendar.add', { ...VALID['calendar.add'], location: undefined, notes: undefined }), {
    summary: 'Add "Dentist" to your Google Calendar on Tuesday, November 3, from 3 PM to 4 PM. No one is invited.',
  });
  assert.equal(
    words('calendar.add', { ...VALID['calendar.add'], start: '2026-11-03T15:30:00-05:00', end: '2026-11-03T16:45:00-05:00' }).summary,
    'Add "Dentist" to your Google Calendar on Tuesday, November 3, from 3:30 PM to 4:45 PM, at 12 Main St. No one is invited.',
  );
  // the listener's zone, not the server's
  assert.equal(
    words('calendar.add', { title: 'Call Tokyo', allDay: false, start: '2026-11-03T15:00:00-05:00', end: '2026-11-03T16:00:00-05:00', timeZone: 'Asia/Tokyo' }).summary,
    'Add "Call Tokyo" to your Google Calendar on Wednesday, November 4, from 5 AM to 6 AM. No one is invited.',
  );
  assert.equal(
    words('calendar.add', { title: 'Night shift', allDay: false, start: '2026-11-03T22:00:00-05:00', end: '2026-11-04T06:00:00-05:00', timeZone: 'America/New_York' }).summary,
    'Add "Night shift" to your Google Calendar from Tuesday, November 3 at 10 PM to Wednesday, November 4 at 6 AM. No one is invited.',
  );
  assert.equal(
    words('calendar.add', { title: 'Late', allDay: false, start: '2026-11-03T23:00:00-05:00', end: '2026-11-04T00:00:00-05:00', timeZone: 'America/New_York' }).summary,
    'Add "Late" to your Google Calendar on Tuesday, November 3, from 11 PM to 12 AM. No one is invited.',
  );
  assert.equal(words('calendar.add', { title: 'Holiday', allDay: true, start: '2026-12-24', end: '2026-12-25', timeZone: 'Europe/Berlin' }).summary, 'Add "Holiday" to your Google Calendar on Thursday, December 24, all day. No one is invited.');
  assert.equal(words('calendar.add', { title: 'Ski week', allDay: true, start: '2027-01-04', end: '2027-01-09', timeZone: 'UTC' }).summary, 'Add "Ski week" to your Google Calendar from Monday, January 4, 2027 to Friday, January 8, 2027, all day. No one is invited.');
  assert.equal(words('task.add', { title: 'Send the quotes', due: '2026-11-05' }).summary, 'Add "Send the quotes" to your Google Tasks, due Thursday, November 5.');
  assert.equal(words('task.add', { title: 'Milk' }, { listTitle: 'Home' }).summary, 'Add "Milk" to your "Home" list in Google Tasks.');
  assert.equal(words('task.complete', VALID['task.complete']).summary, 'Mark "Send the quotes" as done in your Google Tasks.');
  assert.equal(words('task.edit', { listId: 'L', taskId: 'T', due: '2026-11-06' }, { currentTitle: 'Send the quotes' }).summary, 'Change "Send the quotes" in your Google Tasks: make it due Friday, November 6.');
  assert.equal(words('task.edit', { listId: 'L', taskId: 'T', notes: null }, {}).summary, 'Change the task in your Google Tasks: remove its notes.');
  const ctx = { title: 'Q4 budget review', organizer: 'Dana Reyes', start: Date.parse('2026-11-09T19:00:00Z'), tz: 'America/New_York' };
  assert.deepEqual(words('invite.respond', { eventId: 'e', response: 'accepted' }, ctx), {
    summary: 'Answer yes to "Q4 budget review" on Monday, November 9, at 2 PM. Dana Reyes, the organizer, will see your answer.',
    others: 'Dana Reyes, the organizer, will see your answer.',
  });
  assert.match(words('invite.respond', { eventId: 'e', response: 'tentative', note: 'Might be late' }, ctx).summary, /^Answer maybe to .+\. Your note: "Might be late"\. Dana Reyes/);
  assert.equal(words('invite.respond', { eventId: 'e', response: 'declined' }, { title: 'Offsite', allDay: true, startDate: '2026-11-12' }).summary, 'Answer no to "Offsite" on Thursday, November 12. The organizer will see your answer.');
  // plain words: no em dash anywhere, no narrow no-break spaces
  const all = JSON.stringify([words('calendar.add', VALID['calendar.add']), words('invite.respond', VALID['invite.respond'], ctx)]);
  assert.ok(!all.includes(ch(0x2014)) && !all.includes(ch(0x202f)));
  assert.equal(whenWords({ allDay: false, start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:00:00Z', timeZone: 'UTC' }, NOW), 'on Tuesday, November 3, from 3 PM to 4 PM');
});

test('scopes: calendar.events is calendarEvents (never calendar), tasks is tasks; the switch names parse', () => {
  assert.deepEqual(shortGoogleScopes('openid https://www.googleapis.com/auth/calendar.events'), ['calendarEvents']);
  assert.deepEqual(shortGoogleScopes('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks'), ['calendar', 'tasks']);
  assert.deepEqual(shortGoogleScopes('https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/calendar'), [], 'not the ones we ask for');
  assert.deepEqual(parseScopeList('calendarEvents,TASKS calendar bogus calendarevents'), ['calendarEvents', 'tasks', 'calendar', 'calendarEvents']);
});

test('schemas over HTTP: 300 fuzzed proposals answer 201 or 400, never 500', async (t) => {
  const { propose, store } = await setup(t);
  const rand = rng(7);
  const shapes = [
    () => timedEvent(30 + Math.floor(rand() * 100), { title: 'a'.repeat(Math.floor(rand() * 130)) }),
    () => ({ ...timedEvent(30), attendees: [{ email: 'boss@x.test' }] }),
    () => ({ ...timedEvent(30), timeZone: rand() < 0.5 ? 'Nowhere/City' : 'UTC' }),
    () => ({ title: rand() < 0.5 ? 7 : 'x', listId: rand() < 0.5 ? '@default' : '../../x' }),
    () => ({ title: `x${ch(0x202e)}` }),
    () => 'not an object',
    () => null,
  ];
  const codes = new Map();
  for (let i = 0; i < 300; i++) {
    const s = Math.floor(rand() * shapes.length);
    const type = s < 3 ? 'calendar.add' : 'task.add';
    const r = await propose(type, shapes[s]());
    codes.set(r.statusCode, (codes.get(r.statusCode) ?? 0) + 1);
    assert.ok([201, 400].includes(r.statusCode), `${r.statusCode} ${r.body}`);
    if (r.statusCode === 400) assert.ok(['invalid_action'].includes(r.json().error.code) && r.json().error.field, r.body);
  }
  assert.ok(codes.get(201) > 10 && codes.get(400) > 10, JSON.stringify([...codes]));
  assert.equal(store.state.writes.length, 0, 'proposing never writes');
});
