import { describe, expect, it } from 'vitest';
import { builtinTurn, fill, joinLines, writeBuiltinBreak } from './builtin';
import { hosts, NOW, packet, pastBreak, seeded, station } from './fixtures';
import { planBreak } from './planner';

const lineup = hosts(2);

function breakFor(seed: number, len: 'short' | 'normal' | 'long' = 'normal', p = packet(), kind?: 'opening' | 'callin', callIn?: string) {
  const s = station({ talkLength: len });
  const plan = planBreak(s, p, p.recentBreaks, { now: NOW, rand: seeded(seed), kind, callIn, hostCount: lineup.length });
  return { plan, lines: writeBuiltinBreak(s, lineup, plan, p, { rand: seeded(seed + 100), now: NOW }) };
}

describe('scripted fallback (template lines)', () => {
  it('fills templates and capitalizes on demand', () => {
    expect(fill('{Cond} in {place}', { cond: 'light rain', place: 'Porto' })).toBe('Light rain in Porto');
  });

  it('writes exactly the planned number of lines, alternating hosts', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const len of ['short', 'normal', 'long'] as const) {
        const { plan, lines } = breakFor(seed, len);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.length).toBeLessThanOrEqual(plan.lines);
        for (let i = 1; i < lines.length; i++) expect(lines[i]!.hostId).not.toBe(lines[i - 1]!.hostId);
      }
    }
  });

  it('names the songs and only uses facts from the packet', () => {
    const { lines } = breakFor(7, 'long');
    const text = lines.map((l) => l.text).join(' ');
    expect(text).toMatch(/Midnight City/);
    expect(text).toMatch(/Dreams/);
    expect(text).not.toMatch(/\{|\}|undefined|NaN/);
    expect(text).not.toMatch(/ana@example\.com/);
  });

  it('is varied: different seeds give different breaks', () => {
    const texts = new Set(Array.from({ length: 12 }, (_, i) => breakFor(i + 1).lines.map((l) => l.text).join('|')));
    expect(texts.size).toBeGreaterThanOrEqual(10);
  });

  it('avoids openers that aired in recent breaks', () => {
    const p = packet({ recentBreaks: [pastBreak(['songs'], 5, 'That was Midnight City by M83.')] });
    for (let seed = 1; seed <= 10; seed++) {
      const { lines } = breakFor(seed, 'short', p);
      expect(lines[0]!.text.startsWith('That was Midnight City by M83.')).toBe(false);
    }
  });

  it('welcomes listeners on the opening break and answers call-ins', () => {
    const open = breakFor(3, 'normal', packet(), 'opening').lines.map((l) => l.text).join(' ');
    expect(open).toMatch(/Host-Caster 88\.1/);
    const call = breakFor(3, 'short', packet(), 'callin', 'Play something upbeat please').lines.map((l) => l.text).join(' ');
    expect(call).toMatch(/Sam/);
    expect(call).toMatch(/upbeat|energy|tempo/i);
  });

  it('gives a host with no AI brain one scripted line in a turn-by-turn break', () => {
    const s = station();
    const plan = planBreak(s, packet(), [], { now: NOW, rand: () => 0 });
    expect(builtinTurn(s, lineup, lineup[1]!, plan, packet(), 1, { rand: seeded(2) }).length).toBeGreaterThan(5);
  });
});

describe('joinLines', () => {
  it('does not say the same filler twice when two lines merge', () => {
    expect(joinLines('Mm, that’s a nice one.', 'Mm. Night Market by City Pulse.')).toBe('Mm, that’s a nice one. Night Market by City Pulse.');
    expect(joinLines('Oh wow.', 'Oh, here we go.')).toBe('Oh wow. Here we go.');
    expect(joinLines('That was great.', 'Mm. Next up.')).toBe('That was great. Mm. Next up.');
  });
});
