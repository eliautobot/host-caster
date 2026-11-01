// Day first: the talk mix, one item from the listener's day per break, and the hourly rundown.
import { describe, expect, it } from 'vitest';
import type { Break } from '../types';
import { hosts, NOW, packet, pastBreak, seeded, settled, station } from './fixtures';
import { breaksSinceOutro, DAY_SEGMENTS, DEFAULT_TALK_MIX, planBreak, planTopicKeys, rundownDue, talkMixOf } from './planner';
import { buildScriptPrompt, factsSheet } from './prompt';
import { writeBuiltinBreak } from './builtin';

const MIN = 60_000;
const news = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `news:h${i}`, title: `Headline number ${i}`, source: 'NPR News' }));

/** Plays `count` regular breaks `gap` minutes apart, logging each like the radio does. */
function run(count: number, opts: { mix?: number; gap?: number; p?: ReturnType<typeof packet>; len?: 'short' | 'normal' | 'long'; start?: number } = {}) {
  const s = station({ talkMix: opts.mix, talkLength: opts.len ?? 'normal' });
  const recent: Break[] = [];
  let now = opts.start ?? NOW;
  const plans = [];
  for (let i = 0; i < count; i++) {
    const plan = planBreak(s, opts.p ?? packet(), recent, { now, rand: seeded(i + 1), kind: i === 0 ? 'opening' : 'regular' });
    plans.push(plan);
    recent.unshift({ ...pastBreak(planTopicKeys(plan), 0), id: `b${i}`, at: now });
    now += (opts.gap ?? 8) * MIN;
  }
  return plans;
}

describe('talk mix', () => {
  it('defaults to leaning toward the listener day and clamps odd values', () => {
    expect(DEFAULT_TALK_MIX).toBe(3);
    expect(talkMixOf(station())).toBe(3);
    expect(talkMixOf(station({ talkMix: 9 }))).toBe(4);
    expect(talkMixOf(station({ talkMix: -2 }))).toBe(0);
    expect(talkMixOf(station({ talkMix: Number.NaN }))).toBe(3);
  });

  it('always introduces the next song; back-announces 1 in 3 at the default, every break at Music', () => {
    const def = run(12);
    expect(def.every((p) => p.intro)).toBe(true);
    expect(def.filter((p) => p.outro).length).toBe(4);
    const music = run(12, { mix: 0 });
    expect(music.every((p) => p.outro && p.intro)).toBe(true);
    const day = run(12, { mix: 4 });
    expect(day.filter((p) => p.outro).length).toBe(3);
  });

  it('counts older logs that only said songs as a back-announce', () => {
    expect(breaksSinceOutro([pastBreak(['songs'], 5)])).toBe(0);
    expect(breaksSinceOutro([pastBreak(['songs', 'intro'], 5), pastBreak(['songs', 'intro', 'outro'], 12)])).toBe(1);
    expect(breaksSinceOutro([pastBreak(['callin'], 2), pastBreak(['songs', 'outro', 'intro'], 9)])).toBe(0);
  });

  it('tells the model to keep the song to one short sentence at the default, more song talk at Music', () => {
    const p = packet({ recentBreaks: settled() });
    const def = buildScriptPrompt(station(), hosts(2), planBreak(station(), p, p.recentBreaks, { now: NOW, rand: () => 0 }), p);
    expect(def.user).toMatch(/one short sentence \(title and artist\)/);
    const music = buildScriptPrompt(station({ talkMix: 0 }), hosts(2), planBreak(station({ talkMix: 0 }), p, p.recentBreaks, { now: NOW, rand: () => 0 }), p);
    expect(music.user).toMatch(/music-first show/);
  });
});

describe('your day in every break', () => {
  it('carries an item from the listener day in every regular break, at every mix but Music', () => {
    // a real day: the packet holds several events, mails and headlines (the fixture has one of each)
    const p = packet({
      calendar: Array.from({ length: 5 }, (_, i) => ({ id: `ev${i}`, title: `Event ${i}`, start: NOW + (i + 1) * 25 * MIN, allDay: false, source: 'ics' as const })),
      email: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, from: `Friend ${i}`, subject: `Plans ${i}`, important: i === 0, at: NOW - i * MIN })),
      news: news(25),
    });
    for (const mix of [1, 2, 3, 4]) {
      for (const len of ['short', 'normal', 'long'] as const) {
        const plans = run(15, { mix, len, p }).slice(1);
        for (const p of plans) expect(p.items.some((i) => DAY_SEGMENTS.has(i.segment))).toBe(true);
      }
    }
  });

  it('a listener with only news still hears a headline every break, never the same one twice', () => {
    const p = packet({ calendar: [], email: [], reminders: [], lifeEvents: [], notes: [], news: news(20) });
    const plans = run(10, { p }).slice(1);
    const heads = plans.flatMap((x) => x.items.filter((i) => i.segment === 'news').map((i) => i.key));
    expect(plans.every((x) => x.items.some((i) => i.segment === 'news'))).toBe(true);
    expect(new Set(heads).size).toBe(heads.length);
  });

  it("ranks today's events above the weather and the time, not only events in the next two hours", () => {
    const morning = new Date(2026, 9, 29, 9, 0).getTime();
    const p = packet({
      now: { ...packet().now, iso: new Date(morning).toISOString(), partOfDay: 'morning' },
      calendar: [{ id: 'lunch', title: 'Lunch with Ana', start: morning + 5 * 60 * MIN, allDay: false, source: 'ics' }],
      reminders: [],
      email: [],
      lifeEvents: [],
      notes: [],
      news: [],
    });
    for (let seed = 1; seed < 20; seed++) {
      const plan = planBreak(station({ talkLength: 'short' }), p, [pastBreak(['rundown'], 5)].map((b) => ({ ...b, at: morning - 5 * MIN })), { now: morning, rand: seeded(seed) });
      expect(plan.topics).toEqual(['calendar']);
    }
  });

  it('Music keeps the old behaviour: no forced day item', () => {
    const p = packet({ reminders: [], calendar: [], lifeEvents: [], email: [], notes: [], news: news(3) });
    const s = station({ talkMix: 0, talkLength: 'short', segments: { ...station().segments, time: true, funFacts: true } });
    const topics = Array.from({ length: 20 }, (_, i) => planBreak(s, p, settled(), { now: NOW, rand: seeded(i + 1) }).topics[0]);
    expect(topics.some((t) => t !== 'news')).toBe(true);
  });
});

describe('rundown', () => {
  it('opens a session with a rundown: next events, reminders, weather and a headline', () => {
    const plan = planBreak(station(), packet(), [], { now: NOW, kind: 'opening', rand: () => 0 });
    expect(plan.rundown).toBe(true);
    expect(plan.topics).toEqual(expect.arrayContaining(['calendar', 'reminders', 'weather', 'news']));
    expect(plan.items.length).toBeLessThanOrEqual(5);
    expect(plan.lines).toBeGreaterThanOrEqual(5);
    expect(planTopicKeys(plan)).toContain('rundown');
    const prompt = buildScriptPrompt(station(), hosts(2), plan, packet());
    expect(prompt.user).toMatch(/quick rundown of the listener's day/);
    expect(factsSheet(plan, packet(), station())).not.toMatch(/ALSO ON THE CALENDAR/);
  });

  it('comes back on the first break after the top of each hour, once', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();
    const log = (h: number, m: number, topics: string[]) => ({ ...pastBreak(topics, 0), at: at(h, m) });
    expect(rundownDue('regular', [log(21, 35, ['rundown'])], at(21, 50))).toBe(false);
    expect(rundownDue('regular', [log(21, 58, ['songs']), log(21, 35, ['rundown'])], at(22, 2))).toBe(true);
    // a rundown in the last ten minutes of the hour counts for the next one
    expect(rundownDue('regular', [log(21, 55, ['rundown'])], at(22, 3))).toBe(false);
    expect(rundownDue('stream', [log(21, 35, ['rundown'])], at(22, 1))).toBe(true);
    expect(rundownDue('callin', [], at(22, 1))).toBe(false);
  });

  it('skips quietly when there is nothing to run down', () => {
    const empty = packet({ calendar: [], reminders: [], email: [], news: [], lifeEvents: [], notes: [], weather: undefined });
    const plan = planBreak(station(), empty, [], { now: NOW, kind: 'opening', rand: () => 0 });
    expect(plan.rundown).toBeUndefined();
    expect(plan.intro).toBe(true);
  });

  it('the scripted fallback reads a rundown within its lines', () => {
    const s = station();
    const plan = planBreak(s, packet(), [], { now: NOW, kind: 'opening', rand: () => 0 });
    const lines = writeBuiltinBreak(s, hosts(2), plan, packet(), { rand: seeded(4), now: NOW });
    const text = lines.map((l) => l.text).join(' ');
    expect(lines.length).toBeLessThanOrEqual(plan.lines);
    expect(text).toMatch(/Dentist/);
    expect(text).toMatch(/pharmacy/i);
    expect(text).toMatch(/Dreams/);
  });
});
