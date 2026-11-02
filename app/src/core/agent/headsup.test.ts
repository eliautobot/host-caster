// The heads-up watch with a stand-in server: what the hosts last knew is the baseline; a cancelled meeting and an
// urgent mail are told once (a newsletter never); quiet while paused; slower after a rate limit; reminders before
// meetings, none after "got it".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, HeadsUp } from '../types';
import { station } from '../radio/fixtures';

const watchAnswers: unknown[] = [];
const watchCalls: unknown[] = [];
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: { available: true, signedIn: true },
  integrations: {
    watch: vi.fn(async (q: unknown) => {
      watchCalls.push(q);
      const next = watchAnswers.shift();
      if (next instanceof Error) throw next;
      return next ?? { calendar: { changed: [], checkedAt: Date.now() }, gmail: { historyId: '100', messages: [] } };
    }),
    calendar: vi.fn(async () => ({ events: [] })),
  },
  request: vi.fn(async () => ({ messages: [] })),
}));
// no AI brain: the rules judge the mail, the notes are the facts
vi.mock('./research', async (orig) => ({ ...(await orig<typeof import('./research')>()), leadWithBrain: async () => undefined }));

const { headsUpWatch, listHeadsUps, markAired, snoozeLast, pendingHeadsUps } = await import('./headsup');
const db = await import('../db');

const MIN = 60_000;
const now = Date.now();
const q4: CalendarEvent = {
  id: 'cal:q4',
  title: 'Q4 budget review',
  start: now + 60 * MIN,
  end: now + 120 * MIN,
  allDay: false,
  source: 'google',
  organizer: 'Dana Reyes',
  attendees: [
    { name: 'Dana Reyes', status: 'accepted', organizer: true },
    { name: 'Mike Chen', status: 'accepted' },
  ],
};
const st = station();
const delivered: HeadsUp[] = [];
let playing = true;
const hooks = {
  playing: () => playing,
  deliver: async (h: HeadsUp) => {
    delivered.push(h);
    // the radio tells it on air
    await markAired([h.id], 'breakin', h.say ?? h.fact);
  },
};
const mail = (id: string, extra: Record<string, unknown>) => ({ id, from: 'Dana Reyes', subject: 'Hi', important: false, at: now, source: 'gmail', ...extra });

describe('heads-up watch', () => {
  beforeEach(async () => {
    delivered.length = 0;
    watchCalls.length = 0;
    playing = true;
    const s = await db.getSettings();
    await db.saveSettings({ connections: { ...s.connections, calendar: { google: true, icsUrls: [] }, email: { gmail: true, imap: false }, headsUps: { breakIn: 'now', remindMin: 10 } } });
  });

  it('tells a cancelled meeting and an urgent mail once; a newsletter never; the hosts\' calendar is updated', async () => {
    await db.kvSet('calendar:google', [q4], now - 2 * MIN);
    headsUpWatch.start(st, hooks, 3_600_000);
    // first check: the mailbox's place (no mail told yet)
    await headsUpWatch.checkNow();
    expect(watchCalls[0]).toMatchObject({ since: now - 2 * MIN });
    watchAnswers.push({
      calendar: { changed: [{ id: 'cal:q4', cancelled: true }], checkedAt: Date.now() },
      gmail: {
        historyId: '105',
        messages: [
          mail('dana1', { subject: 'Urgent: vendor quotes before 2pm', snippet: 'Can you send them ASAP?' }),
          mail('promo', { from: 'Big Shop', subject: 'URGENT: last chance 50% off', bulk: true }),
          mail('gcal', { from: 'Google Calendar <calendar-notification@google.com>', subject: 'Canceled event: Q4 budget review', body: 'Q4 budget review has been canceled. Note from the organizer: Mike is out sick, new time Thursday.', bulk: true }),
        ],
      },
    });
    await headsUpWatch.checkNow();
    expect(watchCalls[1]).toMatchObject({ historyId: '100' });
    expect(delivered.map((h) => h.id).sort()).toEqual(['cancelled:cal:q4', 'urgent:dana1']);
    expect(delivered.find((h) => h.kind === 'cancelled')!.note).toContain('was cancelled');
    // the calendar's notice says why (a notification mail: never a heads-up of its own)
    expect(delivered.find((h) => h.kind === 'cancelled')!.source).toBe('Mike is out sick, new time Thursday.');
    // the same change reported again (Google's "changed since" overlaps): no repeat
    watchAnswers.push({ calendar: { changed: [{ id: 'cal:q4', cancelled: true }], checkedAt: Date.now() }, gmail: { historyId: '106', messages: [mail('dana1', { subject: 'Urgent: vendor quotes before 2pm' })] } });
    await headsUpWatch.checkNow();
    expect(delivered).toHaveLength(2);
    // the breaks read the fresh calendar: the cancelled meeting is gone
    expect((await db.kvGet<CalendarEvent[]>('calendar:google'))!.value).toEqual([]);
    expect((await listHeadsUps()).every((h) => h.state === 'aired')).toBe(true);
    headsUpWatch.stop();
  });

  it('quiet while paused; slower after the server asks to slow down', async () => {
    playing = false;
    headsUpWatch.start(st, hooks, 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(watchCalls).toHaveLength(0);
    playing = true;
    watchAnswers.push(Object.assign(new Error('Too many requests'), { status: 429 }));
    headsUpWatch.start(st, hooks, 5);
    await new Promise((r) => setTimeout(r, 60));
    expect(watchCalls).toHaveLength(1);
    expect(headsUpWatch.status().lastError).toMatch(/Too many/);
    expect(headsUpWatch.status().nextAt! - Date.now()).toBeGreaterThan(9 * MIN);
    headsUpWatch.stop();
  });

  it('a reminder 10 minutes before a meeting with guests; none after "got it"', async () => {
    const soon = { ...q4, id: 'cal:sync', title: 'Design sync', start: Date.now() + 10 * MIN, end: Date.now() + 40 * MIN };
    const later = { ...q4, id: 'cal:later', title: 'Vendor call', start: Date.now() + 10 * MIN, end: Date.now() + 40 * MIN };
    await db.kvSet('calendar:google', [soon], Date.now());
    headsUpWatch.start(st, hooks, 3_600_000);
    await headsUpWatch.checkNow();
    await new Promise((r) => setTimeout(r, 60));
    const r = delivered.find((h) => h.kind === 'reminder');
    expect(r).toMatchObject({ id: `reminder:cal:sync:${soon.start}`, title: 'Design sync' });
    // "got it": snoozed
    expect((await snoozeLast())?.id).toBe(r!.id);
    expect((await listHeadsUps()).find((h) => h.id === r!.id)!.state).toBe('snoozed');
    // another meeting still gets its own reminder; nothing pending is left over
    await db.kvSet('calendar:google', [later], Date.now());
    headsUpWatch.start(st, hooks, 3_600_000);
    await headsUpWatch.checkNow();
    await new Promise((r2) => setTimeout(r2, 60));
    expect(delivered.filter((h) => h.kind === 'reminder').map((h) => h.title)).toEqual(['Design sync', 'Vendor call']);
    expect(await pendingHeadsUps()).toEqual([]);
    headsUpWatch.stop();
  });
});
