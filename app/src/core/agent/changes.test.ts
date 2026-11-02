// Heads-ups, the pure part: calendar diffing, urgent mail by the rules, reminders, delivery by importance.
import { describe, expect, it } from 'vitest';
import type { CalendarEvent, HeadsUp } from '../types';
import {
  applyChanges,
  BREAKINS_PER_HOUR,
  deliveryFor,
  diffCalendar,
  feedChanges,
  isAcknowledgement,
  mailByRules,
  peopleToday,
  reminderAt,
  reminderHeadsUp,
  scriptedSay,
  urgentMailHeadsUp,
  type WatchedMail,
} from './changes';

const NOW = new Date(2026, 10, 1, 13, 0).getTime();
const MIN = 60_000;
const ev = (id: string, startMin: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: id === 'q4' ? 'Q4 budget review' : `Event ${id}`,
  start: NOW + startMin * MIN,
  end: NOW + (startMin + 60) * MIN,
  allDay: false,
  source: 'google',
  organizer: 'Dana Reyes',
  attendees: [
    { name: 'Dana Reyes', status: 'accepted', organizer: true },
    { name: 'Mike Chen', status: 'accepted' },
    { name: 'Me', status: 'accepted', self: true },
  ],
  ...extra,
});
const q4 = ev('q4', 60);
const lunch = ev('lunch', 300, { title: 'Team lunch', location: 'Cafe Uno' });

describe('diffCalendar', () => {
  it('a meeting within 2 hours cancelled: urgent, with who it was with', () => {
    const [h] = diffCalendar([q4, lunch], [{ id: 'q4', cancelled: true }], NOW);
    expect(h).toMatchObject({ kind: 'cancelled', id: 'cancelled:q4', major: true, eventId: 'q4' });
    expect(h!.fact).toBe('"Q4 budget review" at 2 PM was cancelled. It was with Dana and Mike. Dana Reyes organized it.');
  });

  it('moved: time and place; urgent only when close', () => {
    const [far] = diffCalendar([q4, lunch], [{ ...lunch, location: 'Room 4' }], NOW);
    expect(far).toMatchObject({ kind: 'moved', major: false });
    expect(far!.fact).toBe('"Team lunch" is now at Room 4, not Cafe Uno.');
    const [near] = diffCalendar([q4], [{ ...q4, start: q4.start + 30 * MIN }], NOW);
    expect(near).toMatchObject({ kind: 'moved', major: true, id: `moved:q4:t${q4.start + 30 * MIN}` });
    expect(near!.fact).toBe('"Q4 budget review" moved from 2 PM to 2:30 PM.');
  });

  it('new and soon (added last minute), an invitation to answer, a guest declining, a video link', () => {
    const fresh = ev('sync', 10, { title: 'Quick sync' });
    expect(diffCalendar([q4], [fresh], NOW)[0]).toMatchObject({ kind: 'new', major: true });
    expect(diffCalendar([q4], [ev('later', 240, { invitation: true })], NOW)[0]).toMatchObject({ kind: 'invite', major: false });
    const declined = { ...q4, attendees: q4.attendees!.map((a) => (a.name === 'Mike Chen' ? { ...a, status: 'declined' as const } : a)) };
    expect(diffCalendar([q4], [declined], NOW)[0]!.fact).toBe('Mike Chen declined "Q4 budget review".');
    expect(diffCalendar([q4], [{ ...q4, video: { provider: 'Google Meet', url: 'https://meet.example.com/x' } }], NOW)[0]!.fact).toBe('"Q4 budget review" now has a Google Meet link.');
  });

  it('nothing to tell: the same event again, far-off changes, own events, own declines', () => {
    expect(diffCalendar([q4], [{ ...q4, description: 'new agenda' }], NOW)).toEqual([]);
    expect(diffCalendar([q4], [ev('next-week', 7 * 24 * 60)], NOW)).toEqual([]);
    expect(diffCalendar([{ ...q4, organizerSelf: true }], [{ id: 'q4', cancelled: true }], NOW)).toEqual([]);
    expect(diffCalendar([q4], [{ id: 'q4', cancelled: true, declinedByMe: true }], NOW)).toEqual([]);
  });

  it('a calendar feed: missing events count as cancelled; changes apply to what the hosts know', () => {
    const changes = feedChanges([q4, lunch], [{ ...lunch, start: lunch.start + 60 * MIN }], NOW);
    expect(changes.map((c) => [c.id, Boolean(c.cancelled)])).toEqual([
      ['lunch', false],
      ['q4', true],
    ]);
    expect(diffCalendar([q4, lunch], changes, NOW).map((h) => h.kind)).toEqual(['moved', 'cancelled']);
    expect(applyChanges([q4, lunch], changes).map((e) => e.id)).toEqual(['lunch']);
  });
});

describe('urgent mail (no brain)', () => {
  const mail = (extra: Partial<WatchedMail>): WatchedMail => ({ id: 'm', from: 'Dana Reyes', subject: 'Quick question', important: false, at: NOW, ...extra });
  const meet = peopleToday([q4], NOW);

  it('knows who the listener meets today', () => expect(meet).toEqual(['dana', 'mike']));

  it('urgent: from someone they meet today asking for something today; a reply in their thread saying ASAP', () => {
    expect(mailByRules(mail({ subject: 'Urgent: vendor quotes before 2pm' }), meet)).toMatchObject({ urgent: true });
    expect(mailByRules(mail({ from: 'Sam Ortiz', subject: 'Re: contract', reply: true, snippet: 'Can you send it ASAP?' }), meet).urgent).toBe(true);
  });

  it('never: newsletters and promos, automatic senders, ordinary mail', () => {
    expect(mailByRules(mail({ from: 'Big Shop', subject: 'URGENT: last chance, 50% off today', bulk: true }), meet)).toMatchObject({ urgent: false, candidate: false });
    expect(mailByRules(mail({ from: 'News Digest <newsletter@site.example>', subject: 'Urgent update' }), meet).candidate).toBe(false);
    expect(mailByRules(mail({ from: 'Sam Ortiz', subject: 'Photos from the weekend' }), meet)).toMatchObject({ urgent: false, candidate: false });
    // a stranger shouting "urgent" in the text only: not without a sign it is real
    expect(mailByRules(mail({ from: 'Sam Ortiz', subject: 'Hello', snippet: 'urgent reply needed' }), meet).urgent).toBe(false);
  });

  it('the heads-up names the sender and the gist, never the address', () => {
    const h = urgentMailHeadsUp(mail({ from: 'Dana Reyes', subject: 'Urgent: vendor quotes before 2pm' }), 'Urgent email', NOW, 'needs the three vendor quotes before the 2 PM review');
    expect(h.fact).toBe('An urgent email just came in from Dana Reyes: needs the three vendor quotes before the 2 PM review.');
    expect(scriptedSay(h, NOW)).toBe('Quick heads-up: an urgent email just came in from Dana Reyes: needs the three vendor quotes before the 2 PM review.');
  });
});

describe('a brain-written heads-up line', () => {
  it('goes on air only when it tells this change', async () => {
    const { onTopic } = await import('./headsup');
    const mail = { kind: 'urgent' as const, title: 'Urgent: vendor quotes before 2pm', fact: 'An urgent email just came in from Dana Reyes: send the quotes.' };
    expect(onTopic('Quick heads-up: Dana needs the three vendor quotes by 2 PM.', mail)).toBe(true);
    expect(onTopic("Quick heads-up: your Design sync is at 3:17. I couldn't verify the urgent email.", mail)).toBe(false);
    const cancel = { kind: 'cancelled' as const, title: 'Q4 budget review', fact: '"Q4 budget review" at 2 PM was cancelled.' };
    expect(onTopic('Quick heads-up: your Q4 budget review at 2 PM was cancelled; Mike is out sick.', cancel)).toBe(true);
    expect(onTopic('Quick heads-up: lunch moved to noon.', cancel)).toBe(false);
  });
});

describe('reminders', () => {
  it('fires 10 minutes before a meeting with guests or a video call, not for a solo or declined one', () => {
    expect(reminderAt(ev('a', 12), 10, NOW, 150_000)).toBe(NOW + 2 * MIN);
    expect(reminderAt(ev('a', 40), 10, NOW, 150_000)).toBeUndefined();
    expect(reminderAt(ev('solo', 12, { attendees: [] }), 10, NOW, 150_000)).toBeUndefined();
    expect(reminderAt(ev('call', 12, { attendees: [], video: { provider: 'Zoom', url: 'https://zoom.example/x' } }), 10, NOW, 150_000)).toBe(NOW + 2 * MIN);
    expect(reminderAt(ev('no', 12, { myResponse: 'declined' }), 10, NOW, 150_000)).toBeUndefined();
    expect(reminderAt(ev('a', 12), 0, NOW, 150_000)).toBeUndefined();
  });

  it('says who, what to bring and that the link is there, counted for the moment it is said', () => {
    const h = reminderHeadsUp({ ...q4, video: { provider: 'Google Meet', url: 'https://meet.example/x' } }, ['the three vendor quotes'], NOW);
    expect(h.fact).toBe('"Q4 budget review" with Dana and Mike starts at 2 PM. To bring or prepare: the three vendor quotes. The Google Meet link is in the event.');
    expect(scriptedSay(h, q4.start - 10 * MIN)).toBe('Heads-up, "Q4 budget review" with Dana and Mike starts in ten minutes. To bring or prepare: the three vendor quotes. The Google Meet link is in the event.');
  });
});

describe('delivery', () => {
  const major = { kind: 'cancelled', major: true } as HeadsUp;
  const normal = { kind: 'moved', major: false } as HeadsUp;
  const ctx = { breakIn: 'now' as const, breakInsLastHour: 0, songLeftMs: 180_000, breakAfterSong: false };

  it('urgent breaks in over the music; waits when the song ends within 90 s; normal goes first in the next break', () => {
    expect(deliveryFor(major, ctx)).toBe('breakin');
    expect(deliveryFor(major, { ...ctx, songLeftMs: 60_000 })).toBe('afterSong');
    expect(deliveryFor(normal, ctx)).toBe('nextBreak');
    // a stream (no song end): over the music
    expect(deliveryFor(major, { ...ctx, songLeftMs: undefined })).toBe('breakin');
  });

  it('the listener setting and the hourly limit', () => {
    expect(deliveryFor(major, { ...ctx, breakIn: 'after' })).toBe('afterSong');
    expect(deliveryFor(major, { ...ctx, breakIn: 'off' })).toBe('nextBreak');
    expect(deliveryFor(major, { ...ctx, breakInsLastHour: BREAKINS_PER_HOUR })).toBe('afterSong');
  });

  it('"got it" and "thanks" acknowledge; a question does not', () => {
    expect(isAcknowledgement('Got it, thanks!')).toBe(true);
    expect(isAcknowledgement('thanks')).toBe(true);
    expect(isAcknowledgement('Why was it cancelled?')).toBe(false);
  });
});
