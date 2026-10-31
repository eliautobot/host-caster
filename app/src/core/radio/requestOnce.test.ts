// A song request is named once per break (live QA 18:47: a call-in announced "Bonito, Bonito" in lines 1 and 4).
import { describe, expect, it } from 'vitest';
import type { TrackSummary } from '../types';
import { writeBuiltinBreak } from './builtin';
import { hosts, NOW, packet, seeded, station } from './fixtures';
import { planBreak, requestIsNext } from './planner';
import { buildScriptPrompt, buildTurnPrompt, factsSheet } from './prompt';

const dreams = { id: 't2', title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', durationMs: 257_000, source: 'local' } as TrackSummary;
const count = (text: string, word: string) => text.split(word).length - 1;

describe('a song request is named once per break', () => {
  it('call-in: named in the answer, then not again (no "end by introducing their request")', () => {
    const p = { ...packet(), songAfter: undefined };
    const plan = planBreak(station(), p, [], { now: NOW, kind: 'callin', callIn: 'Play Dreams by Fleetwood Mac next', request: { query: 'dreams fleetwood mac', found: dreams }, rand: () => 0 });
    expect(requestIsNext(plan, p)).toBe(false);
    const facts = factsSheet(plan, p, station());
    expect(facts).toContain('SONG REQUEST from the listener: "Dreams" by Fleetwood Mac. It plays after the song that is on now.');
    expect(facts).toContain('Name it ONCE in the whole break, in your answer to the call; never name it twice.');
    const script = buildScriptPrompt(station(), hosts(2), plan, p).user;
    expect(script).toContain('Say yes and name their song, once.');
    expect(script).toContain('do not name it again');
    expect(script).not.toContain('End by introducing their request');
    const first = buildTurnPrompt(station(), hosts(2), hosts(2)[0]!, plan, p, [], 0).user;
    expect(first).toContain('Name their requested song here, once.');
    const later = buildTurnPrompt(station(), hosts(2), hosts(2)[1]!, plan, p, [{ hostId: hosts(2)[0]!.id, text: 'Dreams is coming!' }], plan.lines - 1).user;
    expect(later).toContain('already named: do not name it again');
  });

  it('a request that is also the next song: only the last line names it, no separate UP NEXT', () => {
    const p = packet();
    const plan = planBreak(station(), p, [], { now: NOW, request: { query: 'dreams', found: dreams }, requestFrom: 'app', rand: () => 0 });
    expect(plan.intro).toBe(true);
    expect(requestIsNext(plan, p)).toBe(true);
    const facts = factsSheet(plan, p, station());
    expect(facts).not.toContain('UP NEXT:');
    expect(count(facts, '"Dreams"')).toBe(1);
    expect(facts).toContain('in the last line, as the next song');
    const turns = Array.from({ length: plan.lines }, (_, i) => buildTurnPrompt(station(), hosts(2), hosts(2)[i % 2]!, plan, p, [], i).user);
    expect(turns.slice(0, -1).every((t) => t.includes('Do not name the requested song in this line'))).toBe(true);
    expect(turns.at(-1)).toContain('Name their requested song here (the only time in this break).');
  });

  it('scripted fallback: the title is said once, for a call-in and for a request that is next', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = packet();
      const s = station();
      const next = planBreak(s, p, p.recentBreaks, { now: NOW, rand: seeded(seed), request: { query: 'dreams', found: dreams }, requestFrom: 'app', hostCount: 2 });
      const text = writeBuiltinBreak(s, hosts(2), next, p, { rand: seeded(seed + 100), now: NOW }).map((l) => l.text).join(' ');
      expect(count(text, 'Dreams'), `seed ${seed}: ${text}`).toBe(next.intro ? 1 : count(text, 'Dreams'));
      if (next.intro) expect(text).toMatch(/request/i);

      const call = { ...packet(), songAfter: undefined };
      const callPlan = planBreak(s, call, call.recentBreaks, { now: NOW, rand: seeded(seed), kind: 'callin', callIn: 'Play Dreams', request: { query: 'dreams', found: dreams }, hostCount: 2 });
      const said = writeBuiltinBreak(s, hosts(2), callPlan, call, { rand: seeded(seed + 100), now: NOW }).map((l) => l.text).join(' ');
      expect(count(said, 'Dreams'), `seed ${seed}: ${said}`).toBe(1);
    }
  });
});
