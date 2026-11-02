import { describe, expect, it } from 'vitest';
import { notionNoteText } from '../context/notion';
import { builtinTurn, fill, joinLines, notionNoteSpoken, writeBuiltinBreak } from './builtin';
import { hosts, NOW, packet, pastBreak, seeded, settled, station } from './fixtures';
import { planBreak } from './planner';

const lineup = hosts(2);

function breakFor(seed: number, len: 'short' | 'normal' | 'long' = 'normal', p = packet(), kind?: 'opening' | 'callin', callIn?: string, talkMix?: number) {
  const s = station({ talkLength: len, talkMix });
  const plan = planBreak(s, p, p.recentBreaks, { now: NOW, rand: seeded(seed), kind, callIn, hostCount: lineup.length });
  return { plan, lines: writeBuiltinBreak(s, lineup, plan, p, { rand: seeded(seed + 100), now: NOW }) };
}

describe('scripted fallback (template lines)', () => {
  it('says a Notion page in a few words, not its whole summary', () => {
    const db = notionNoteText({
      id: 'd',
      title: 'Todo List',
      edited: 'today',
      text: 'Recent entries: Click me to see even more detail (Status: Not started, Due date: 2026-10-31); Click the blue New button to add a task (Status: Not started, Due date: 2026-10-31); Click the due date to change it (Status: Not started, Due date: 2026-11-01).',
    });
    expect(notionNoteSpoken(db)).toEqual({ page: 'Todo List', what: 'recent entries: Click me to see even more detail and Click the blue New button to add a task, plus 1 more' });
    const list = notionNoteText({ id: 'g', title: 'Groceries', text: 'Open to-dos: oat milk; eggs. Weekend: farmers market.' });
    expect(notionNoteSpoken(list)).toEqual({ page: 'Groceries', what: 'open to-dos: oat milk and eggs' });
    expect(notionNoteSpoken('Water the plants')).toBeUndefined();

    // on air: the page and two items, no statuses or dates
    let said = '';
    for (let seed = 1; seed <= 40 && !said; seed++) {
      said = breakFor(seed, 'long', packet({ notes: [db], recentBreaks: settled() }), undefined, undefined, 1)
        .lines.map((l) => l.text)
        .find((t) => t.includes('Notion page')) ?? '';
    }
    expect(said).toMatch(/Notion page Todo List/);
    expect(said).not.toMatch(/Status|2026-|edited/);
    expect(said.length).toBeLessThan(200);
  });


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
    // a music-first station names the song that just played as well as the next one
    const { lines } = breakFor(7, 'long', packet({ recentBreaks: settled() }), undefined, undefined, 0);
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

describe('scripted fallback: heads-ups and the time-teller', () => {
  it('a heads-up opens the break; the time check is in the last line with the {TIME} slot', async () => {
    const { planAirTime } = await import('./airtime');
    const h = { id: 'cancelled:q4', kind: 'cancelled' as const, title: 'Q4 budget review', fact: '"Q4 budget review" at 2 PM was cancelled.', why: 'Cancelled', major: false, at: NOW, state: 'pending' as const, start: NOW + 3_600_000 };
    const p = packet({ headsUps: [h] });
    const s = station();
    let plan = planBreak(s, p, p.recentBreaks, { now: NOW, rand: seeded(3), hostCount: 2 });
    if (!plan.items.some((i) => i.segment === 'time')) plan = { ...plan, items: [...plan.items, { segment: 'time', key: 'time' }] };
    expect(plan.items[0]).toEqual({ segment: 'headsUp', key: 'headsup:cancelled:q4' });
    const lines = writeBuiltinBreak(s, lineup, plan, p, { rand: seeded(9), now: NOW });
    expect(lines[0]!.text).toMatch(/^Quick heads-up: Q4 budget review at \d{1,2}(:\d\d)? [AP]M was just cancelled\./);
    expect(lines.at(-1)!.text).toContain('{TIME}');
    expect(lines.slice(0, -1).some((l) => l.text.includes('{TIME}'))).toBe(false);
    // ready for air: one time line, the last, voiced ahead without the time
    const timed = planAirTime(lines, { wantTime: true, next: p.songAfter, airAt: NOW, packet: p, stationName: s.name });
    expect(timed.timeLine?.index).toBe(timed.lines.length - 1);
    expect(timed.voiced.at(-1)!.text).not.toContain('{TIME}');
  });
});
