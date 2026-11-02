// What the hosts know about an item: event and email details, scripted dossiers, the follow-up answers without a
// model, dossiers a model writes (no invented links), ICS feed details, the break prompt, and the wire shapes.
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../context/ics';
import { factsSheet } from '../radio/prompt';
import type { BreakPlan } from '../radio/planner';
import type { CalendarEvent, ContextPacket, EmailSummary, Station } from '../types';
import { eventDetailFacts, linkedEmails, peopleWords, researchItems, scriptedEventDossier } from './brief';
import { isFollowUpQuestion, scriptedAnswer, targetItem, type FollowItem } from './followup';
import { dossierFrom } from './research';
import { fromOpenAIToolCalls, toAnthropicMessages, toOpenAIMessages } from './step';
import { dayOffset } from './tools';

const NOW = Date.parse('2026-11-08T15:00:00Z');
const review: CalendarEvent = {
  id: 'me@example.com:q4review7nkl3lnqohsgg9inv',
  title: 'Q4 budget review',
  start: NOW + 23 * 3_600_000,
  end: NOW + 24 * 3_600_000,
  allDay: false,
  source: 'google',
  location: 'Room 4B',
  description: 'Agenda\n1. Vendor numbers\n2. Q4 plan',
  organizer: 'Dana Reyes',
  guests: 4,
  attendees: [
    { name: 'Dana Reyes', status: 'accepted', organizer: true },
    { name: 'Mike Chen', status: 'accepted' },
    { name: 'Priya Shah', status: 'tentative', optional: true },
    { name: 'Me', status: 'needsAction', self: true },
  ],
  myResponse: 'needsAction',
  invitation: true,
  video: { provider: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij' },
  attachments: ['Q4 vendor quotes.xlsx'],
  updated: NOW - 3_600_000,
};
const dana: EmailSummary = {
  id: '18f0000000000002',
  from: 'Dana Reyes',
  subject: 'Re: Q4 budget review',
  important: true,
  at: NOW - 7_200_000,
  body: 'Hi, For the Q4 budget review on Monday, please bring the vendor numbers (the three quotes from October). Mike will cover the Q4 plan.',
};
const invite: EmailSummary = { id: '18f0000000000001', from: 'Dana Reyes', subject: 'Invitation: Q4 budget review @ Mon Nov 9', important: true, at: NOW - 9_000_000, invite: { method: 'request', eventId: 'q4review7nkl3lnqohsgg9inv', title: 'Q4 budget review' } };

describe('event details', () => {
  it('who, the invitation, the video call (no link), attachments, the related email', () => {
    expect(peopleWords(review)).toBe('Dana Reyes (organizer, said yes), Mike Chen (said yes), Priya Shah (said maybe)');
    expect(linkedEmails(review, [dana, invite]).map((m) => m.id)).toEqual([dana.id, invite.id]);
    const facts = eventDetailFacts(review, [dana, invite]);
    expect(facts[0]).toBe('WHAT IT IS ABOUT: Agenda; 1. Vendor numbers; 2. Q4 plan');
    expect(facts[1]).toMatch(/^WHO: Dana Reyes \(organizer, said yes\).*\(4 invited\)\.$/);
    expect(facts[2]).toMatch(/Dana Reyes invited the listener and they have not answered yet; it is a Google Meet call \(never read the link\); attached: Q4 vendor quotes\.xlsx/);
    expect(facts[3]).toMatch(/^RELATED EMAIL from Dana Reyes: Hi, For the Q4 budget review on Monday, please bring the vendor numbers/);
    expect(facts.join(' ')).not.toMatch(/https?:/);
  });

  it('research items: invitations first, versions follow changes; the scripted dossier', () => {
    const items = researchItems({ calendar: [review, { ...review, id: 'x:allday', title: 'Holiday', allDay: true, invitation: false, description: undefined, guests: undefined }], email: [dana, invite], news: [{ id: 'news:1', title: 'Prices rise', source: 'Example News', url: 'https://news.example.com/a' }] }, NOW);
    expect(items[0]!.key).toBe(`calendar:${review.id}`);
    expect(items.map((i) => i.kind)).toEqual(['calendar', 'email', 'email', 'calendar', 'news']);
    expect(JSON.parse(items[0]!.known).relatedEmails[0].text).toMatch(/vendor numbers/);
    expect(items[0]!.version).toBe(String(review.updated));
    const d = scriptedEventDossier(review, [dana], NOW);
    expect(d.who).toEqual(['Dana Reyes (organizer)', 'Mike Chen (said yes)', 'Priya Shah (said maybe)']);
    expect(d.prepare).toEqual(['Look at Q4 vendor quotes.xlsx']);
    expect(d.questions).toEqual(['The invitation is not answered yet.']);
    expect(d.links?.[0]).toEqual({ url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' });
    expect(d.sources).toEqual(['The calendar event', 'Email from Dana Reyes']);
  });

  it("a model's dossier keeps only links it was given or found", () => {
    const item = researchItems({ calendar: [review] }, NOW)[0]!;
    const d = dossierFrom(
      { about: 'The quarterly budget review with Dana and Mike.', who: ['Dana Reyes (organizer)'], prepare: 'Bring the vendor numbers', links: [{ label: 'Draft', url: 'https://docs.example.com/q4-draft' }, { url: 'https://invented.example.com/x' }] },
      item,
      'found {"links":[{"url":"https://docs.example.com/q4-draft"}]}',
      { at: NOW },
    )!;
    expect(d.by).toBe('ai');
    expect(d.prepare).toEqual(['Bring the vendor numbers']);
    expect(d.links).toEqual([{ url: 'https://docs.example.com/q4-draft', label: 'Draft' }]);
    expect(dossierFrom({ who: ['x'] }, item, '', {})).toBeUndefined();
  });
});

describe('follow-ups without a model', () => {
  const items: FollowItem[] = [
    { key: `calendar:${review.id}`, kind: 'calendar', title: review.title, event: review, aired: true, said: 'Your 2 o clock tomorrow is the Q4 budget review.' },
    { key: `email:${dana.id}`, kind: 'email', title: dana.subject, email: dana, aired: false },
    { key: 'news:1', kind: 'news', title: 'Vendor prices rise 4%', headline: { id: 'news:1', title: 'Vendor prices rise 4%', source: 'Example News' }, aired: true },
  ];
  it('knows a question from a request', () => {
    expect(isFollowUpQuestion("Who's coming to that?")).toBe(true);
    expect(isFollowUpQuestion('tell me more about that story')).toBe(true);
    expect(isFollowUpQuestion('read me the email about it')).toBe(true);
    expect(isFollowUpQuestion('play some Beyonce')).toBe(false);
    expect(isFollowUpQuestion('add oat milk to my list')).toBe(false);
  });
  it('who, the email, the video link, the story', () => {
    expect(scriptedAnswer("who's coming to that?", items, NOW).answer).toBe('For Q4 budget review: Dana Reyes (organizer, said yes), Mike Chen (said yes), Priya Shah (said maybe).');
    expect(scriptedAnswer('read me the email about the budget review', items, NOW).answer).toMatch(/^Dana Reyes wrote: Hi, For the Q4 budget review on Monday, please bring the vendor numbers/);
    expect(scriptedAnswer('is there a video link?', items, NOW).answer).toBe('Yes, Q4 budget review has a Google Meet link. It\'s in the event in your calendar.');
    const story = scriptedAnswer('tell me more about that story', items, NOW);
    expect(story.found).toBe(false);
    expect(story.answer).toBe('All I have is the headline: Vendor prices rise 4%.');
    expect(targetItem('what about the vendor prices', items)?.key).toBe('news:1');
    expect(scriptedAnswer('what is my dentist about', [], NOW).found).toBe(false);
  });
});

describe('the break prompt carries the details', () => {
  it('WHAT IT IS ABOUT and WHO for the chosen event; a follow-up answer for a call-in', () => {
    const station = { name: 'Morning', frequency: '101.1', segments: {}, talkLength: 'normal' } as unknown as Station;
    const packet = {
      now: { iso: new Date(NOW).toISOString(), local: '', partOfDay: 'morning', weekday: 'Sunday' },
      listener: { name: '', callMe: '', about: '', interests: [], avoid: [] },
      upcomingSongs: [],
      recentBreaks: [],
      calendar: [review],
      email: [dana],
    } as unknown as ContextPacket;
    const plan: BreakPlan = { kind: 'regular', topics: ['calendar'], items: [{ segment: 'calendar', key: `calendar:${review.id}` }], lines: 3, outro: false, intro: false, mix: 3 };
    const facts = factsSheet(plan, packet, station, NOW);
    expect(facts).toMatch(/CALENDAR: Q4 budget review tomorrow at/);
    expect(facts).toMatch(/WHAT IT IS ABOUT: Agenda/);
    expect(facts).toMatch(/WHO: Dana Reyes \(organizer, said yes\)/);
    const call = factsSheet({ ...plan, kind: 'callin', items: [], callIn: "who's coming?", followUp: { question: "who's coming?", answer: 'Dana and Mike said yes; Priya said maybe.', found: true, sources: [], by: 'ai', ms: 0, lookups: 1 } }, packet, station, NOW);
    expect(call).toMatch(/ANSWER TO THE LISTENER'S QUESTION \(checked in their own calendar, email, notes and lookups\): Dana and Mike said yes; Priya said maybe\./);
  });
});

describe('calendar feeds (ICS) carry details too', () => {
  it('description, organizer, guests with answers, video, recurrence', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:abc@x',
      'DTSTART:20261109T190000Z',
      'DTEND:20261109T200000Z',
      'SUMMARY:Team sync',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'DESCRIPTION:Talk about the launch.\\nJoin: https://zoom.us/j/123456789\\nMeeting ID: 123 456 789',
      'ORGANIZER;CN=Dana Reyes:mailto:dana@example.com',
      'ATTENDEE;CN=Dana Reyes;PARTSTAT=ACCEPTED:mailto:dana@example.com',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:mike.chen@example.com',
      'ATTENDEE;CUTYPE=ROOM;CN=Room 4B:mailto:room@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [e] = parseIcs(ics, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-10T00:00:00Z'));
    expect(e!.description).toBe('Talk about the launch.\nJoin:');
    expect(e!.video).toEqual({ provider: 'Zoom', url: 'https://zoom.us/j/123456789' });
    expect(e!.organizer).toBe('Dana Reyes');
    expect(e!.attendees).toEqual([{ name: 'Dana Reyes', status: 'accepted', organizer: true }, { name: 'Mike Chen', status: 'declined' }]);
    expect(e!.rooms).toEqual(['Room 4B']);
    expect(e!.recurrence).toBe('weekly on Monday');
  });
});

describe('wire shapes and helpers', () => {
  it('OpenAI and Anthropic tool turns', () => {
    const msgs = [
      { role: 'user' as const, content: 'Q' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'weather', args: { day: 'friday' } }] },
      { role: 'tool' as const, toolCallId: 'c1', name: 'weather', content: '{"high":20}' },
    ];
    const o = toOpenAIMessages(msgs);
    expect(o[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"day":"friday"}' } }] });
    expect(o[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"high":20}' });
    const a = toAnthropicMessages(msgs);
    expect(a[1]!.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'weather', input: { day: 'friday' } }]);
    expect(a[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"high":20}' }] });
    expect(fromOpenAIToolCalls({ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'web_search', arguments: '{"query":"q4"' } }] })).toEqual([{ id: 'x', name: 'web_search', args: {} }]);
  });
  it('weather days', () => {
    const sunday = new Date('2026-11-08T12:00:00');
    expect(dayOffset('tomorrow', sunday)).toBe(1);
    expect(dayOffset('friday', sunday)).toBe(5);
    expect(dayOffset('2026-11-10', sunday)).toBe(2);
    expect(dayOffset('2026-12-25', sunday)).toBeUndefined();
  });
});
