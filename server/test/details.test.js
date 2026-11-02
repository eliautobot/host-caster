// Event and email details from REAL Google API shapes (fixtures dumped from the test account, then scrubbed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cleanText, eventIdFromEid, inviteOf, looksLikeInvite, messageText, personName, recurrenceWords, stripQuoted } from '../src/integrations/details.js';
import { toEmail, toEvent } from '../src/integrations/google.js';

const cal = JSON.parse(readFileSync(new URL('./fixtures/google/calendar-events.json', import.meta.url), 'utf8'));
const mail = JSON.parse(readFileSync(new URL('./fixtures/google/gmail-messages.json', import.meta.url), 'utf8'));
const primary = { id: 'me@example.com', summary: 'me@example.com', summaryOverride: 'Work' };

test('calendar: an invitation I have not answered, with guests, video call, attachment', () => {
  const e = toEvent(primary, cal.invited);
  assert.equal(e.title, 'HC fixture: Q4 budget review');
  assert.equal(e.calendar, 'Work');
  assert.equal(e.organizer, 'Dana Reyes');
  assert.equal(e.invitation, true);
  assert.equal(e.myResponse, 'needsAction');
  assert.equal(e.guests, 4); // the room is not a guest
  assert.deepEqual(e.rooms, ['Room 4B']);
  assert.deepEqual(
    e.attendees.map((a) => [a.name, a.status]),
    [
      ['Dana Reyes', 'accepted'],
      ['Mike Chen', 'accepted'],
      ['Priya Shah', 'tentative'],
      ['Me', 'needsAction'],
    ],
  );
  assert.equal(e.attendees[3].self, true);
  assert.deepEqual(e.video, { provider: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(e.attachments, ['Q4 vendor quotes.xlsx']);
  assert.match(e.description, /Agenda\n1\. Vendor numbers\n2\. Q4 plan/);
  assert.doesNotMatch(e.description, /https?:|<|meet\.google/);
  assert.ok(e.links.every((l) => !/meet\.google/.test(l.url)), 'the video link is not a reading link');
  assert.match(e.link, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
});

test('calendar: a weekly series instance says how it repeats; my own event is no invitation', () => {
  const e = toEvent(primary, cal.instance, { master: cal.master });
  assert.equal(e.recurrence, 'weekly');
  assert.equal(e.invitation, undefined);
  assert.equal(e.organizer, undefined);
  const own = toEvent(primary, cal.withAttendee);
  assert.equal(own.description, 'Bring the insurance card. Arrive 10 minutes early.');
  assert.equal(own.invitation, undefined);
  assert.equal(toEvent(primary, cal.instance).recurring, true); // no series at hand
});

test('recurrence words', () => {
  assert.equal(recurrenceWords(['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']), 'every weekday');
  assert.equal(recurrenceWords(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU']), 'every 2 weeks on Tuesday');
  assert.equal(recurrenceWords(['EXDATE:20261101', 'RRULE:FREQ=MONTHLY']), 'monthly');
  assert.equal(recurrenceWords(['RRULE:FREQ=DAILY']), 'daily');
  assert.equal(recurrenceWords([]), undefined);
});

test('clean text: html, entities, links apart, dial-in lines out, capped at a word', () => {
  const { text, links } = cleanText('<p>Hi &amp; welcome</p><a href="https://x.test/a">the deck</a><br>Meeting ID: 123 456<br>+1 415-555-0100<br>See https://y.test/b.', 600);
  assert.equal(text, 'Hi & welcome\nthe deck\nSee');
  assert.deepEqual(links, [{ url: 'https://x.test/a', label: 'the deck' }, { url: 'https://y.test/b' }]);
  assert.equal(cleanText('word '.repeat(100), 40).text.endsWith('...'), true);
  assert.ok(cleanText('word '.repeat(100), 40).text.length <= 43);
});

test('names: display name wins, else from the address, never the address', () => {
  assert.equal(personName('Dana Reyes', 'dana@example.com'), 'Dana Reyes');
  assert.equal(personName('', 'mike.chen@example.com'), 'Mike Chen');
  assert.equal(personName('"x@y.example"', 'x@y.example'), 'someone');
});

test('gmail: an invitation email links to its event and its calendar method', () => {
  const m = mail.invite;
  assert.equal(looksLikeInvite(m), true);
  const inv = inviteOf(m);
  assert.equal(inv.title, 'Q4 budget review');
  assert.equal(inv.method, 'request');
  assert.equal(inv.eventId, 'abc0demo0event0q4r0001');
  assert.equal(eventIdFromEid('YWJjMGRlbW8wZXZlbnQwcTRyMDAwMSBtZUBleGFtcGxlLmNvbQ'), 'abc0demo0event0q4r0001');
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc123@google.com\r\nSUMMARY:Q4 budget\r\n  review\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const withIcs = inviteOf(m, ics);
  assert.equal(withIcs.uid, 'abc123@google.com');
  assert.equal(withIcs.title, 'Q4 budget review');
  const acc = inviteOf(mail.accept);
  assert.equal(acc.method, 'reply');
  assert.equal(acc.answer, 'accepted');
  assert.equal(looksLikeInvite(mail.dana), false);
});

test('gmail: an invitation from an unknown sender (Google holds it off the calendar) is marked', () => {
  const held = structuredClone(mail.invite);
  const subj = held.payload.headers.find((h) => h.name === 'Subject');
  subj.value = 'Invitation from an unknown sender: HC RSVP test @ Mon Nov 2, 2026 4pm - 5pm (EST) (me@example.com)';
  const inv = inviteOf(held);
  assert.equal(inv.title, 'HC RSVP test');
  assert.equal(inv.method, 'request');
  assert.equal(inv.unknownSender, true);
  assert.equal(inviteOf(mail.invite).unknownSender, undefined);
});

test('gmail: a reply reads as what the person wrote (no quote), links kept apart', () => {
  const { text, links } = messageText(mail.dana, 1500);
  assert.match(text, /please bring the vendor numbers \(the three quotes from October\)/);
  assert.doesNotMatch(text, /Sounds good|wrote:|https?:/);
  assert.equal(links[0].url, 'https://docs.example.com/q4-draft');
  const e = toEmail(mail.dana, { body: { text, links }, threadSize: 2 });
  assert.equal(e.from, 'Dana Reyes');
  assert.equal(e.subject, 'Re: Q4 budget review');
  assert.equal(e.threadSize, 2);
  assert.equal(e.important, true);
  assert.equal(e.threadId, mail.dana.threadId);
  assert.equal(stripQuoted('Yes\n\nOn Mon, Nov 2, 2026 at 9:00 AM A <a@b.c> wrote:\n> old'), 'Yes\n');
});

test('gmail: a message with only a snippet has no body', () => {
  const m = { id: 'm1', snippet: 'Hi &amp; bye', payload: { headers: [{ name: 'From', value: 'A <a@b.c>' }] } };
  assert.equal(toEmail(m, { body: messageText(m) }).body, undefined);
  assert.equal(toEmail(m).snippet, 'Hi & bye');
});
