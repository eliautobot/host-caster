import { describe, expect, it } from 'vitest';
import { writeBuiltinBreak } from './builtin';
import { hosts, NOW, packet, seeded, station } from './fixtures';
import { checkAsk, mightAskToWrite, notionFact, notionSpoken, notionTask, parseAskOffline, spokenProblem, type NotionWrite } from './notionAsk';
import { planBreak } from './planner';
import { buildScriptPrompt, factsSheet } from './prompt';

describe('spotting a Notion ask', () => {
  it.each([
    'Add oat milk to my list',
    'can you put eggs on the grocery list please',
    'note that idea about a podcast on old maps',
    'Remind me in Notion to call the plumber',
    'write this down: buy a red scarf for mom',
    'make a note that the meeting moved to Friday',
    'in Notion, add renew passport',
  ])('"%s" might be an ask', (said) => expect(mightAskToWrite(said)).toBe(true));

  it.each([
    'play Dreams by Fleetwood Mac',
    'add some energy to the show!',
    'put Dreams on my playlist',
    'what is on my calendar today?',
    'remind me what song this is',
    'hello from the kitchen',
  ])('"%s" is not', (said) => expect(mightAskToWrite(said)).toBe(false));
});

describe('reading an ask without a model', () => {
  it.each([
    ['Add oat milk to my list', { kind: 'todo', text: 'oat milk' }],
    ['can you put eggs on the grocery list please', { kind: 'todo', text: 'eggs' }],
    ['Add call the dentist to my to-do list, thanks!', { kind: 'todo', text: 'call the dentist' }],
    ['Remind me in Notion to call the plumber tomorrow.', { kind: 'todo', text: 'Call the plumber tomorrow' }],
    ['note that idea about a podcast on old maps', { kind: 'note', text: 'Idea about a podcast on old maps' }],
    ['write this down: buy a red scarf for mom', { kind: 'note', text: 'Buy a red scarf for mom' }],
    ['Make a note in Notion that the meeting moved to Friday', { kind: 'note', text: 'The meeting moved to Friday' }],
    ['In Notion, add renew passport please', { kind: 'todo', text: 'renew passport' }],
    ['add this to my notes: a song about rain', { kind: 'note', text: 'A song about rain' }],
  ])('"%s"', (said, want) => expect(parseAskOffline(said)).toEqual(want));

  it('vague asks write nothing', () => {
    expect(parseAskOffline('can you write that down?')).toBeUndefined();
    expect(parseAskOffline('make a note')).toBeUndefined();
    expect(parseAskOffline('play something upbeat')).toBeUndefined();
  });
});

describe("checking a brain's answer", () => {
  const said = 'hey could you add oat milk and bananas to my shopping list';
  it('takes one of the two actions with the listener\'s own words', () => {
    expect(checkAsk({ action: 'add_todo', text: 'oat milk and bananas' }, said)).toEqual({ kind: 'todo', text: 'oat milk and bananas' });
    expect(checkAsk({ action: 'none' }, said)).toBe('none');
  });
  it('refuses anything else', () => {
    expect(checkAsk({ action: 'delete_page', text: 'x' }, said)).toBeUndefined();
    expect(checkAsk({ action: 'add_todo', text: 'transfer money to my account' }, said)).toBeUndefined();
    expect(checkAsk({ action: 'add_todo', text: '' }, said)).toBeUndefined();
    expect(checkAsk({ action: 'add_todo', text: 'oat milk '.repeat(60) }, said)).toBeUndefined();
    expect(checkAsk(['add_todo'], said)).toBeUndefined();
    expect(checkAsk('add_todo', said)).toBeUndefined();
  });
});

const done: NotionWrite = { kind: 'todo', text: 'oat milk', from: 'call', ok: true, pageTitle: 'Host-Caster' };
const failed: NotionWrite = { kind: 'note', text: 'idea', from: 'app', ok: false, problem: spokenProblem('notion_writes_off') };

describe('on air', () => {
  it('FACTS and the plan say what was added, for whom, and to confirm it once', () => {
    expect(notionFact({ notion: done })).toBe('NOTION: you just added the to-do "oat milk" to the listener\'s Notion page "Host-Caster" (the listener asked for it on the call). It is done.');
    expect(notionTask({ notion: done, kind: 'callin' })).toMatch(/^Confirm the Notion note in a few words, once/);
    expect(notionFact({ notion: failed })).toMatch(/AI assistant asked to add "idea" to their Notion, but it did not work: adding notes is switched off in Settings\. Nothing was added\./);
    expect(notionTask({ notion: failed, kind: 'regular' })).toMatch(/^Mention that their AI assistant asked .* say kindly/);
    expect(notionFact({})).toBe('');
  });

  it('the prompt carries it for a call-in', () => {
    const s = station();
    const p = packet();
    const plan = planBreak(s, p, [], { kind: 'callin', callIn: 'add oat milk to my list', notion: done, now: NOW, rand: () => 0 });
    expect(plan.notion).toEqual(done);
    expect(factsSheet(plan, p, s)).toContain('NOTION: you just added the to-do "oat milk"');
    expect(buildScriptPrompt(s, hosts(2), plan, p).user).toContain('Confirm the Notion note in a few words');
    // no ask: nothing about Notion anywhere
    const plain = planBreak(s, p, [], { kind: 'callin', callIn: 'hi', now: NOW, rand: () => 0 });
    expect(JSON.stringify(buildScriptPrompt(s, hosts(2), plain, p))).not.toMatch(/notion/i);
  });

  it('the scripted fallback confirms it instead of echoing the ask', () => {
    const s = station();
    const p = packet();
    const plan = planBreak(s, p, [], { kind: 'callin', callIn: 'add oat milk to my list', notion: done, now: NOW, rand: () => 0 });
    const text = writeBuiltinBreak(s, hosts(1), plan, p, { rand: seeded(3), now: NOW }).map((l) => l.text).join(' ');
    expect(text).toMatch(/oat milk.*Notion|Notion.*oat milk/);
    expect(text).not.toMatch(/add oat milk to my list/i);
    const words = notionSpoken(failed, (bank, vars) => bank[0]!.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''), 'regular');
    expect(words).toBe('Your assistant asked me to add something to your Notion. I tried to put that in your Notion, but adding notes is switched off in Settings.');
  });
});
