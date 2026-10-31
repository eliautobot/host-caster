import { describe, expect, it } from 'vitest';
import { fitsPartOfDay, numberWords, spokenTime } from './speakable';

const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();

describe('spoken time', () => {
  it('reads the clock like a radio host', () => {
    expect(spokenTime(at(22, 24))).toBe('ten twenty-four');
    expect(spokenTime(at(9, 5))).toBe('nine oh five');
    expect(spokenTime(at(15, 0))).toBe("three o'clock");
    expect(spokenTime(at(0, 0))).toBe('midnight');
    expect(spokenTime(at(12, 0))).toBe('noon');
    expect(spokenTime(at(12, 30))).toBe('twelve thirty');
    expect(spokenTime(at(0, 15))).toBe('twelve fifteen');
  });

  it('spells numbers', () => {
    expect([numberWords(0), numberWords(13), numberWords(40), numberWords(59)]).toEqual(['zero', 'thirteen', 'forty', 'fifty-nine']);
  });
});

describe('catchphrases and the time of day', () => {
  it('keeps morning phrases for mornings and night phrases for nights', () => {
    expect(fitsPartOfDay('Rise and shine', 'night')).toBe(false);
    expect(fitsPartOfDay('Rise and shine', 'morning')).toBe(true);
    expect(fitsPartOfDay("Here's one for the night owls", 'morning')).toBe(false);
    expect(fitsPartOfDay("Here's one for the night owls", 'late-night')).toBe(true);
    expect(fitsPartOfDay('Call it now', 'afternoon')).toBe(true);
  });
});
