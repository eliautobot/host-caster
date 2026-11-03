// The checks the tools share (pure): times resolved by code, writes made of the listener's words, and the no-AI
// command reader that never takes a question as an order ("Can you add things to my Google Tasks?").
import { describe, expect, it } from 'vitest';
import { parseMemoryCommand } from '../../memory/commands';
import { isSongRequest } from '../../radio/requests';
import { parseTrackerCommand } from '../../tracker/commands';
import { isQuestionNotOrder } from '../question';
import { contentWords, grounded } from './sources/needs';
import { searchSongs } from './sources/lookups';
import { dueOrRemind, eventTime } from './when';
import type { Track } from '../../types';

const NY = 'America/New_York';
// Monday, November 2, 2026, 10:00 AM in New York
const ctx = { now: new Date('2026-11-02T15:00:00Z'), tz: NY };

describe('times are resolved by code', () => {
  it('an ISO day is all day with Google\'s exclusive end; an ISO time without an offset is the listener\'s zone', () => {
    const d = eventTime('2026-11-06', undefined, undefined, ctx);
    expect(d.ok && d.when).toMatchObject({ allDay: true, start: '2026-11-06', end: '2026-11-07', spoken: 'Friday, November 6, all day' });
    const t = eventTime('2026-11-06T15:00', undefined, 30, ctx);
    expect(t.ok && t.when).toMatchObject({ allDay: false, start: '2026-11-06T15:00:00-05:00', end: '2026-11-06T15:30:00-05:00' });
    const z = eventTime('2026-11-06T15:00:00Z', '2026-11-06T16:00:00Z', undefined, ctx);
    expect(z.ok && z.when.start).toBe('2026-11-06T10:00:00-05:00');
  });
  it('words go through the listener-time reader; the past, too long and end-before-start are refused', () => {
    const w = eventTime('Friday at 3 PM', undefined, undefined, ctx);
    expect(w.ok && w.when.start).toBe('2026-11-06T15:00:00-05:00');
    expect(w.ok && w.when.end).toBe('2026-11-06T16:00:00-05:00');
    expect(eventTime('2026-11-01T09:00', undefined, undefined, ctx)).toMatchObject({ ok: false, reason: 'past' });
    expect(eventTime('2026-11-01', undefined, undefined, ctx)).toMatchObject({ ok: false, reason: 'past' });
    expect(eventTime('2026-11-06T15:00', '2026-11-06T14:00', undefined, ctx)).toMatchObject({ ok: false, reason: 'end_before_start' });
    expect(eventTime('2026-11-06T15:00', '2026-11-08T15:00', undefined, ctx)).toMatchObject({ ok: false, reason: 'too_long' });
  });
  it('a due day, or a reminder when there is a time', () => {
    expect(dueOrRemind('tomorrow', ctx)).toMatchObject({ due: '2026-11-03', dueAllDay: true });
    const r = dueOrRemind('tomorrow at 9 AM', ctx);
    expect(r).toMatchObject({ due: '2026-11-03T09:00:00-05:00', dueAllDay: false, remindAt: Date.parse('2026-11-03T14:00:00Z') });
    expect('spoken' in r && r.spoken).toMatch(/^Tuesday, November 3 at 9 AM$/);
    expect(dueOrRemind('2026-11-20', ctx)).toMatchObject({ due: '2026-11-20', dueAllDay: true });
    expect(dueOrRemind('2026-10-20', ctx)).toHaveProperty('error');
    expect(dueOrRemind('', ctx)).toHaveProperty('error');
  });
});

describe("writes are made of the listener's words", () => {
  it('grounded: at least half the content words were said', () => {
    expect(grounded('buy batteries', 'oh, buy batteries, by tomorrow')).toBe(true);
    expect(grounded('Batteries', 'I need batteries for the remote')).toBe(true);
    expect(grounded('Dentist appointment', 'move my dentist to Friday')).toBe(true);
    expect(grounded('Wire $500 to account 1234', 'read me my email')).toBe(false);
    expect(grounded('the', 'the')).toBe(false);
    expect(contentWords('Add the things to my Google Tasks')).toEqual(['thing']);
  });
});

describe('the no-AI reader: a question is never an order', () => {
  const now = { now: ctx.now, tz: NY };
  it('Your list', () => {
    expect(parseTrackerCommand('Can you add things to my Google Tasks?', now)).toBeUndefined();
    expect(parseTrackerCommand('Could you add stuff to my list?', now)).toBeUndefined();
    expect(parseTrackerCommand('What should I add to my list?', now)).toBeUndefined();
    expect(parseTrackerCommand('Did I send the quotes?', now)).toBeUndefined();
    expect(parseTrackerCommand('Are you able to add tasks to my list?', now)).toBeUndefined();
    expect(parseTrackerCommand('Can you add milk to my list?', now)).toMatchObject({ op: 'add', what: expect.stringMatching(/^milk$/i) });
    expect(parseTrackerCommand('Add buy batteries to my Google Tasks', now)).toMatchObject({ op: 'add', what: expect.stringMatching(/^buy batteries$/i), google: true });
    expect(parseTrackerCommand('I sent the quotes', now)).toMatchObject({ op: 'done' });
  });
  it('memory and song requests', () => {
    expect(parseMemoryCommand('Can you remember things?')).toBeUndefined();
    expect(parseMemoryCommand('Remember that my sister Ana visits next weekend')).toMatchObject({ op: 'remember' });
    expect(isSongRequest('Can you play songs?')).toBe(false);
    expect(isSongRequest('How do I play music from Spotify?')).toBe(false);
    expect(isSongRequest('Could you play some jazz?')).toBe(true);
    expect(isSongRequest('Play Dreams by Fleetwood Mac')).toBe(true);
  });
  it('isQuestionNotOrder', () => {
    expect(isQuestionNotOrder('Can you add things to my Google Tasks?', 'things')).toBe(true);
    expect(isQuestionNotOrder('Can you add oat milk to my list?', 'oat milk')).toBe(false);
    expect(isQuestionNotOrder('Do you add tasks?')).toBe(true);
    expect(isQuestionNotOrder('Remind me to call mom')).toBe(false);
  });
});

describe('music search', () => {
  const t = (id: string, title: string, artist: string) => ({ id, title, artist }) as Track;
  it('finds songs by title or artist words, best first', () => {
    const lib = [t('1', 'Dreams', 'Fleetwood Mac'), t('2', 'Go Your Own Way', 'Fleetwood Mac'), t('3', 'Dreams', 'The Cranberries')];
    expect(searchSongs('dreams fleetwood mac', lib).map((x) => x.id)).toEqual(['1', '2']);
    expect(searchSongs('fleetwood', lib).map((x) => x.id)).toEqual(['1', '2']);
    expect(searchSongs('beatles', lib)).toEqual([]);
  });
});
