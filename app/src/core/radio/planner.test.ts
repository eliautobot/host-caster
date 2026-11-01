import { describe, expect, it } from 'vitest';
import { NOW, packet, pastBreak, seeded, settled, station } from './fixtures';
import { candidates, factFor, planBreak, planTopicKeys, shouldBreakAfter, TALK_LENGTH_LINES } from './planner';

describe('planner', () => {
  it('breaks every talkEvery songs', () => {
    const s = station({ talkEvery: 3 });
    expect([0, 1, 2].map((n) => shouldBreakAfter(s, n))).toEqual([false, false, true]);
    expect(shouldBreakAfter(station({ talkEvery: 1 }), 0)).toBe(true);
  });

  it('respects talkLength line ranges and gives two hosts at least two lines', () => {
    for (const len of ['short', 'normal', 'long'] as const) {
      for (let seed = 1; seed < 30; seed++) {
        const plan = planBreak(station({ talkLength: len }), packet(), settled(), { now: NOW, rand: seeded(seed), hostCount: 1 });
        const [lo, hi] = TALK_LENGTH_LINES[len];
        expect(plan.lines).toBeGreaterThanOrEqual(lo);
        expect(plan.lines).toBeLessThanOrEqual(hi);
      }
    }
    expect(planBreak(station({ talkLength: 'short' }), packet(), settled(), { now: NOW, rand: () => 0, hostCount: 2 }).lines).toBe(2);
  });

  it('puts urgent items first: a reminder due in 20 min, a calendar event in 40 min, a birthday tomorrow', () => {
    const plan = planBreak(station({ talkLength: 'long' }), packet(), settled(), { now: NOW, rand: () => 0 });
    expect(plan.topics[0]).toBe('reminders');
    expect(plan.topics).toContain('calendar');
    expect(plan.items.map((i) => i.key)).toContain('calendar:dentist');
    expect(plan.intro).toBe(true);
  });

  it('does not repeat a calendar item for 90 minutes (once more when it is about to start), or weather within its cooldown', () => {
    const recent = [pastBreak(['calendar', 'calendar:dentist', 'weather'], 30)];
    const keys = candidates(station(), packet(), recent, NOW).map((c) => c.key);
    expect(keys).not.toContain('calendar:dentist');
    expect(keys).not.toContain('weather');
    const later = candidates(station(), packet(), [pastBreak(['calendar', 'calendar:dentist', 'weather'], 50)], NOW).map((c) => c.key);
    expect(later).not.toContain('calendar:dentist');
    expect(later).toContain('weather');
    // 25 minutes before it starts, last said an hour ago: once more
    const close = NOW + 15 * 60_000;
    const soon = candidates(station(), packet(), [pastBreak(['calendar', 'calendar:dentist'], 50)], close).map((c) => c.key);
    expect(soon).toContain('calendar:dentist');
    // ... but not again ten minutes later
    const twice = [{ ...pastBreak(['calendar', 'calendar:dentist'], 0), at: close }, pastBreak(['calendar', 'calendar:dentist'], 50)];
    expect(candidates(station(), packet(), twice, close + 20 * 60_000).map((c) => c.key)).not.toContain('calendar:dentist');
  });

  it('rotates topics across breaks', () => {
    const s = station({ talkLength: 'normal' });
    const seen = new Set<string>();
    const recent = settled();
    let now = NOW;
    for (let i = 0; i < 6; i++) {
      const plan = planBreak(s, packet({ reminders: [] }), recent, { now, rand: seeded(i + 3) });
      plan.topics.forEach((t) => seen.add(t));
      recent.unshift({ ...pastBreak(planTopicKeys(plan), 0), at: now });
      now += 8 * 60_000;
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('only uses enabled segments', () => {
    const seg = { songs: false, time: false, weather: true, calendar: false, email: false, news: false, lifeEvents: false, notes: false, reminders: false, funFacts: false };
    const plan = planBreak(station({ segments: seg, talkLength: 'long' }), packet(), [], { now: NOW, rand: () => 0.5 });
    expect(plan.topics).toEqual(['weather']);
    expect(plan.intro).toBe(false);
    expect(plan.outro).toBe(false);
  });

  it('call-ins answer first and keep it short; inbox segments jump the queue', () => {
    const call = planBreak(station({ talkLength: 'short' }), packet(), [], { now: NOW, kind: 'callin', callIn: 'Play something upbeat', rand: () => 0 });
    expect(call.callIn).toBe('Play something upbeat');
    expect(call.items).toHaveLength(0);
    expect(call.intro).toBe(false);
    const inbox = packet({ inbox: [{ id: 'i1', kind: 'segment', text: 'Shout-out to the night shift', createdAt: NOW }], reminders: [] });
    expect(planBreak(station(), inbox, settled(), { now: NOW, rand: () => 0 }).topics[0]).toBe('inbox');
  });

  it('picks a fun fact that has not aired recently', () => {
    const seg = { ...station().segments, time: false, weather: false, calendar: false, email: false, news: false, lifeEvents: false, notes: false, reminders: false, funFacts: true };
    const plan = planBreak(station({ segments: seg }), packet(), [pastBreak(['fact:0'], 60)], { now: NOW, rand: () => 0 });
    expect(plan.items[0]!.key).toMatch(/^fact:\d+$/);
    expect(plan.items[0]!.key).not.toBe('fact:0');
    expect(factFor(plan)).toBeTruthy();
  });
});
