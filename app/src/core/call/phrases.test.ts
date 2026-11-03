import { describe, expect, it } from 'vitest';
import { clockOf, isGoodbye, pickupLine, sentences, signOffLine, stillThereLine } from './phrases';

describe('end-of-call phrases', () => {
  it.each(['bye', 'Bye!', 'ok bye', "thanks, that's it", "That's all", "that's all for now, thanks", 'Thank you so much, goodbye', "I'm good, thanks", 'talk to you later', 'gotta go', "no that's it", "that's everything", 'alright, see you', "ok that'll be all"])(
    '"%s" ends the call',
    (s) => expect(isGoodbye(s)).toBe(true),
  );

  it.each([
    "what's on my calendar tomorrow",
    'is that all I have tomorrow?',
    "add dentist Friday at 3, that's it",
    'remember I like jazz',
    'yes',
    'no',
    'thanks',
    'play Later by the Beatles and then something upbeat for the drive home',
    "what's later today",
    "I'm good at remembering things but tell me about the weather",
  ])('"%s" does not', (s) => expect(isGoodbye(s)).toBe(false));
});

describe('call lines', () => {
  it('the pickup says the name and the station', () => {
    expect(pickupLine('Sam', 'Host-Caster', 0)).toBe("Hey Sam, you're on Host-Caster. What's up?");
    expect(pickupLine(undefined, 'Host-Caster', 0)).toBe("Hey, you're on Host-Caster. What's up?");
    // every variant, with and without a name: the station always, the listener whenever there is a name
    for (let seed = 0; seed < 40; seed++) {
      expect(pickupLine('Sam', 'Call FM', seed / 40)).toMatch(/Sam[\s\S]*Call FM|Call FM[\s\S]*Sam/);
      expect(pickupLine(undefined, 'Call FM', seed / 40)).toMatch(/Call FM/);
    }
    expect(new Set(Array.from({ length: 40 }, (_, seed) => pickupLine('Sam', 'Call FM', seed / 40))).size).toBeGreaterThanOrEqual(3);
    expect(stillThereLine('Sam', 0)).toBe('Sam, you still there?');
    expect(signOffLine('Sam', 0)).toMatch(/Sam/);
  });

  it('a reply is spoken sentence by sentence, short bits joined', () => {
    expect(sentences('Sure. Tomorrow you have the dentist at 3 PM. Then lunch with Dana at noon!')).toEqual(['Sure. Tomorrow you have the dentist at 3 PM.', 'Then lunch with Dana at noon!']);
    expect(sentences('Got it.')).toEqual(['Got it.']);
    expect(sentences('It costs 3.50 dollars. That is cheap, right?')).toEqual(['It costs 3.50 dollars.', 'That is cheap, right?']);
    expect(sentences('')).toEqual([]);
  });

  it('the call timer', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(187_400)).toBe('3:07');
  });
});
