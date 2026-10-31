import { describe, expect, it } from 'vitest';
import { hosts } from './fixtures';
import { cleanLine, parseScript, parseTurn } from './script';

const [maya, jules] = hosts(2) as [ReturnType<typeof hosts>[number], ReturnType<typeof hosts>[number]];

describe('script parser', () => {
  it('reads the JSON shape the prompt asks for', () => {
    const raw = '{"lines":[{"host":"Maya","text":"That was Midnight City."},{"host":"Jules","text":"Here is Dreams."}]}';
    expect(parseScript(raw, [maya, jules])).toEqual([
      { hostId: maya.id, text: 'That was Midnight City.' },
      { hostId: jules.id, text: 'Here is Dreams.' },
    ]);
  });

  it('survives code fences, prose, other keys and lowercase names', () => {
    const raw = 'Sure! Here you go:\n```json\n{"script":[{"speaker":"maya","line":"Hey **night owls** 🎶!"},{"name":"JULES","says":"Mm, hello."}]}\n```';
    const out = parseScript(raw, [maya, jules]);
    expect(out.map((l) => l.hostId)).toEqual([maya.id, jules.id]);
    expect(out[0]!.text).toBe('Hey night owls!');
  });

  it('reads broken JSON from small local models (real gemma3 output)', () => {
    const broken = '"lines": [\n"host": "Maya",\n"text": "That was Midnight City by M83."\n"host": "Jules",\n"text": "It\u2019s a beautiful track."';
    expect(parseScript(broken, [maya, jules]).map((l) => l.text)).toEqual(['That was Midnight City by M83.', 'It’s a beautiful track.']);
    const unterminated = '"lines": [\n{"host":"Maya","text":"Okay, it\'s just after nine!"},\n{"host":"Jules","text":"Coming up, Dreams by Fleetwood Mac. \u201cStay with me a while\u201d.\u201d}';
    const out = parseScript(unterminated, [maya, jules]);
    expect(out.map((l) => l.hostId)).toEqual([maya.id, jules.id]);
    expect(out[1]!.text).toBe('Coming up, Dreams by Fleetwood Mac. “Stay with me a while”.');
  });

  it('splits a line that ran into the next one through a curly quote (real gemma3 output)', () => {
    const raw =
      '{"lines":[{"host":"Maya","text":"Hey there, welcome."},{"host":"Jules","text":"Stevie Wonder signed with Motown at eleven. What a start!\u201d}, { Here\u2019s one for the night owls: Dreams is coming up."}]}';
    const out = parseScript(raw, [maya, jules]);
    expect(out.map((l) => l.hostId)).toEqual([maya.id, jules.id, maya.id]);
    expect(out[1]!.text).toBe('Stevie Wonder signed with Motown at eleven. What a start!');
    expect(out[2]!.text).toBe('Here’s one for the night owls: Dreams is coming up.');
    const keyed = '{"lines":[{"host":"Maya","text":"One.\u201d}, {"host": "Jules", "text": "Two."}]}';
    expect(parseScript(keyed, [maya, jules]).map((l) => [l.hostId, l.text])).toEqual([
      [maya.id, 'One.'],
      [jules.id, 'Two.'],
    ]);
  });

  it('falls back to "Name: text" lines and merges a host speaking twice', () => {
    const raw = 'Maya: First thing.\nMaya: Second thing.\nJules: My turn.';
    expect(parseScript(raw, [maya, jules])).toEqual([
      { hostId: maya.id, text: 'First thing. Second thing.' },
      { hostId: jules.id, text: 'My turn.' },
    ]);
  });

  it('assigns unknown speakers round-robin and caps the line count', () => {
    const raw = JSON.stringify([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]);
    const out = parseScript(raw, [maya, jules], 3);
    expect(out.map((l) => l.hostId)).toEqual([maya.id, jules.id, maya.id]);
  });

  it('throws when nothing speakable comes back', () => {
    expect(() => parseScript('{"lines":[]}', [maya, jules])).toThrow();
    expect(() => parseScript('   ', [maya])).toThrow();
  });

  it('cleans stage directions, labels, emojis and wrapping quotes', () => {
    expect(cleanLine('*laughs* (pause) Maya: "Okay, okay." 😄', ['Maya'])).toBe('Okay, okay.');
    expect(cleanLine('[MUSIC SWELLS] Here we go.')).toBe('Here we go.');
    expect(cleanLine('Keep (the good) stuff')).toBe('Keep (the good) stuff.');
  });

  it('drops a dangling quote or comma and an echo of the previous line', () => {
    expect(cleanLine('It’s your mom’s birthday!,')).toBe('It’s your mom’s birthday!');
    expect(cleanLine('Here’s Dreams by Fleetwood Mac. “')).toBe('Here’s Dreams by Fleetwood Mac.');
    const prev = 'That was Midnight City by M83, a total banger!';
    expect(parseTurn('That was Midnight City by M83, a total banger! It always feels quieter after.', jules, [maya, jules], [prev])).toBe('It always feels quieter after.');
  });

  it('turn parsing keeps only the speaker part', () => {
    expect(parseTurn('Love that one.\nMaya: And another thing', jules, [maya, jules])).toBe('Love that one.');
    expect(parseTurn('{"text":"Jules here."}', jules, [maya, jules])).toBe('Jules here.');
    expect(parseTurn('Jules: Hello!', jules, [maya, jules])).toBe('Hello!');
  });
});
