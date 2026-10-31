import { describe, expect, it } from 'vitest';
import { hosts, NOW, packet, pastBreak, station } from './fixtures';
import { planBreak } from './planner';
import { buildScriptPrompt, buildTurnPrompt, factsSheet, scriptMaxTokens } from './prompt';

const plan = (p = packet()) => planBreak(station({ talkLength: 'long' }), p, [], { now: NOW, rand: () => 0 });

describe('prompt builder', () => {
  it('writes the radio voice rules, personas and the avoid list', () => {
    const p = buildScriptPrompt(station(), hosts(2), plan(), packet());
    expect(p.system).toContain('Maya (lead)');
    expect(p.system).toContain('Jules (co-host)');
    expect(p.system).toMatch(/No markdown, no emojis/);
    expect(p.system).toMatch(/Use only the facts in FACTS/);
    expect(p.system).toMatch(/talk to each other by name/);
    expect(p.system).toContain('NEVER MENTION: politics');
    expect(p.system).toMatch(/"lines":\[\{"host":"Maya"/);
    expect(p.system).toMatch(/Catchphrases \(at most one per break/);
  });

  it('puts only packet facts in FACTS, with song titles and artists', () => {
    const facts = factsSheet(plan(), packet(), station());
    expect(facts).toContain('JUST PLAYED: "Midnight City" by M83.');
    expect(facts).toContain('UP NEXT: "Dreams" by Fleetwood Mac.');
    expect(facts).toContain('REMINDER for the listener: Call the pharmacy, in twenty minutes.');
    expect(facts).toContain('CALENDAR: Dentist in forty minutes.');
    expect(facts).toContain('call them Sam');
  });

  it('keeps email privacy-light: sender name and gist, no address or numbers', () => {
    const p = packet({ reminders: [], calendar: [], lifeEvents: [], news: [], notes: [] });
    const seg = { ...station().segments, email: true, time: false, weather: false, funFacts: false };
    const pl = planBreak(station({ segments: seg }), p, [], { now: NOW, rand: () => 0 });
    const facts = factsSheet(pl, p, station());
    expect(facts).toContain('EMAIL: a message from Ana Costa about Saturday brunch plans');
    expect(facts).not.toContain('ana@example.com');
    expect(facts).not.toContain('20261031');
  });

  it('shows recent breaks so the hosts do not repeat themselves', () => {
    const p = packet({ recentBreaks: [pastBreak(['songs'], 10, 'Rise and shine, night owls!')] });
    expect(buildScriptPrompt(station(), hosts(2), plan(p), p).user).toContain('Maya: Rise and shine, night owls!');
  });

  it('call-ins quote the listener and ask for a direct answer', () => {
    const pl = planBreak(station(), packet(), [], { now: NOW, kind: 'callin', callIn: 'Can you say hi to my sister Bea?', rand: () => 0 });
    const p = buildScriptPrompt(station(), hosts(2), pl, packet());
    expect(p.user).toContain('The listener just called in and said: "Can you say hi to my sister Bea?"');
  });

  it('turn-by-turn prompts carry the transcript and the speaker persona', () => {
    const hs = hosts(2);
    const pl = plan();
    const p = buildTurnPrompt(station(), hs, hs[1]!, pl, packet(), [{ hostId: hs[0]!.id, text: 'That was Midnight City.' }], 1);
    expect(p.system).toContain('You are Jules');
    expect(p.user).toContain('Maya: That was Midnight City.');
    expect(p.user).toContain(`Write line 2 of ${pl.lines}`);
  });

  it('says the time in words and forbids made-up plans when FACTS has none', () => {
    const p = packet({ reminders: [], calendar: [], lifeEvents: [], news: [], notes: [], email: [] });
    const seg = { ...station().segments, calendar: false, reminders: false, email: false, notes: false, lifeEvents: false };
    const pl = planBreak(station({ segments: seg }), p, [], { now: NOW, rand: () => 0 });
    const prompt = buildScriptPrompt(station({ segments: seg }), hosts(2), pl, p);
    expect(prompt.user).toMatch(/SAY THE TIME AS: "[a-z' -]+"/);
    expect(prompt.system).toMatch(/do not mention reminders, appointments, plans/);
    expect(prompt.system).not.toMatch(/tell the listener about them/);
    // with a reminder in the plan, the hosts may bring it up
    expect(buildScriptPrompt(station(), hosts(2), plan(), packet()).system).toMatch(/tell the listener about them/);
  });

  it('leaves out catchphrases the hosts said in recent breaks', () => {
    const hs = hosts(2).map((h, i) => (i ? { ...h, catchphrases: ['Stay with me a while', "Here's one for the night owls"] } : h));
    const p = packet({ recentBreaks: [pastBreak(['songs'], 10, 'Here’s one for the night owls: Dreams.')] });
    const system = buildScriptPrompt(station(), hs, plan(p), p).system;
    expect(system).toContain('Stay with me a while');
    expect(system).not.toContain('night owls');
  });

  it('call-ins know the song playing under them', () => {
    const p = packet();
    const pl = planBreak(station(), p, [], { now: NOW, kind: 'callin', callIn: 'Hi!', rand: () => 0 });
    expect(factsSheet(pl, p, station())).toContain('PLAYING NOW, quietly under your voices: "Midnight City" by M83.');
    expect(factsSheet(pl, p, station())).not.toContain('JUST PLAYED');
  });

  it('budgets tokens by length', () => {
    expect(scriptMaxTokens(2, 'short')).toBeLessThan(scriptMaxTokens(8, 'long'));
  });
});
