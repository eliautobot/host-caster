// Air time: one time-teller with a {TIME} slot in the last line, no clock elsewhere, safe "in N minutes" wording,
// clip lengths read from the audio.
import { describe, expect, it } from 'vitest';
import {
  audioLengthMs,
  fillTime,
  noteVoiceMs,
  placeTimeLine,
  planAirTime,
  relativeAt,
  relativeTimes,
  safeRelative,
  saysClock,
  voiceMs,
  withoutTime,
} from './airtime';
import { hosts } from './fixtures';

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 1, h, m, s).getTime();
const next = { title: 'Harbor Lights', artist: 'Tide Machine' };
const L = (hostId: string, text: string) => ({ hostId, text });

describe('placeTimeLine', () => {
  it('keeps one {TIME}, in the last line, and the hand-off when the time is dropped', () => {
    const r = placeTimeLine([L('a', 'That was Dreams. It is {time} here.'), L('b', "It's {TIME}, here's Harbor Lights by Tide Machine.")], true, next);
    expect(r.lines.map((l) => l.text)).toEqual(['That was Dreams.', "It's {TIME}, here's Harbor Lights by Tide Machine."]);
    expect(r.time).toEqual({ index: 1, template: "It's {TIME}, here's Harbor Lights by Tide Machine.", plain: "Here's Harbor Lights by Tide Machine." });
  });

  it('moves a time check written in an earlier line to the last one', () => {
    const r = placeTimeLine([L('a', "Morning! It's [TIME] on a Sunday."), L('b', "Here's Harbor Lights by Tide Machine.")], true, next);
    expect(r.lines[0]!.text).toBe('Morning!');
    expect(r.lines[1]!.text).toBe("It's {TIME} on a Sunday. Here's Harbor Lights by Tide Machine.");
  });

  it('adds a plain time check when the writer forgot it, and takes out a clock time it made up', () => {
    const r = placeTimeLine([L('a', "Right now it's nine twenty-two. Lovely day."), L('b', 'Back to the music.')], true);
    expect(r.lines[0]!.text).toBe('Lovely day.');
    expect(r.time!.template).toBe("It's {TIME}. Back to the music.");
    expect(r.time!.plain).toBe('Back to the music.');
  });

  it('a time-only line has nothing left without its time', () => {
    expect(placeTimeLine([L('a', 'Good stuff.'), L('b', "It's {TIME}.")], true).time!.plain).toBe('');
  });

  it('no time check in the plan: every {TIME} and clock time goes', () => {
    const r = placeTimeLine([L('a', "It's {TIME}. Big news today."), L('b', "It's 9:22 now, here's Harbor Lights by Tide Machine.")], false, next);
    expect(r.time).toBeUndefined();
    expect(r.lines.map((l) => l.text)).toEqual(['Big news today.', "Here's Harbor Lights by Tide Machine."]);
  });
});

describe('time words', () => {
  it('fills the slot with the time a host would say, capitalised at a sentence start', () => {
    expect(fillTime("It's {TIME} on this Sunday.", at(9, 28))).toBe("It's nine twenty-eight on this Sunday.");
    expect(fillTime('{TIME} on the dot.', at(10, 0))).toBe("Ten o'clock on the dot.");
  });

  it('tells a clock time from degrees, percents and event times', () => {
    expect(saysClock("Right now it's nine twenty-eight.")).toBe(true);
    expect(saysClock('Time check: 9:28.')).toBe(true);
    expect(saysClock("It's ten degrees out there.")).toBe(false);
    expect(saysClock('Your meeting is at 3:30 PM.')).toBe(false);
    expect(withoutTime("It's {TIME}. Here's Harbor Lights.")).toBe("Here's Harbor Lights.");
  });
});

describe('relative times', () => {
  const packet = { calendar: [{ id: 'q4', title: 'Q4 review', start: at(9, 44), calendar: 'Work', allDay: false, source: 'google' as const }] };

  it('finds "in N minutes" and the event it points at; recounts it for the moment it is said', () => {
    const text = 'Your Q4 review starts in twenty minutes, and Dana wrote 5 minutes ago.';
    const rel = relativeTimes(text, at(9, 24), packet);
    expect(rel.map((r) => [r.phrase, r.exact, r.past])).toEqual([
      ['in twenty minutes', true, false],
      ['5 minutes ago', false, true],
    ]);
    // six minutes later (a pause)
    expect(relativeAt(text, rel, at(9, 30))).toBe('Your Q4 review starts in fourteen minutes, and Dana wrote eleven minutes ago.');
    // a skip: two minutes early
    expect(relativeAt(text, rel, at(9, 22))).toContain('in twenty-two minutes');
    // the safe version is right whenever it airs
    expect(safeRelative(text, rel)).toBe('Your Q4 review starts at 9:44 AM, and Dana wrote a little while ago.');
  });

  it('"starts now" after a long pause becomes the absolute time', () => {
    const rel = relativeTimes('The Q4 review starts now.', at(9, 44), packet);
    expect(relativeAt('The Q4 review starts now.', rel, at(9, 52))).toBe('The Q4 review starts at 9:44 AM.');
    expect(relativeAt('The Q4 review starts now.', rel, at(9, 40))).toBe('The Q4 review starts in four minutes.');
  });
});

describe('planAirTime', () => {
  it('voices the time line without its time ahead; a one-line break falls back to the station', () => {
    const one = planAirTime([L('a', "It's {TIME}.")], { wantTime: true, airAt: at(9, 24), stationName: 'Wave FM' });
    expect(one.voiced[0]!.text).toBe("You're listening to Wave FM.");
    const two = planAirTime([L('a', 'The Q4 review starts in twenty minutes.'), L('b', "It's {TIME}, here's Harbor Lights by Tide Machine.")], {
      wantTime: true,
      next,
      airAt: at(9, 24),
      packet: { calendar: [{ id: 'q4', title: 'Q4 review', start: at(9, 44), calendar: 'Work', allDay: false, source: 'google' as const }] },
      stationName: 'Wave FM',
    });
    expect(two.voiced[1]!.text).toBe("Here's Harbor Lights by Tide Machine.");
    expect(two.relative[0]!.safe).toBe('The Q4 review starts at 9:44 AM.');
  });
});

describe('clip lengths and voice speed', () => {
  it('reads an MP3 (CBR) and a WAV length from the header', async () => {
    // MPEG-1 layer III, 128 kbps, 44.1 kHz: 16,000 bytes a second
    const mp3 = new Uint8Array(32_000);
    mp3.set([0xff, 0xfb, 0x90, 0x64]);
    expect(await audioLengthMs(new Blob([mp3]))).toBe(2000);
    const wav = new Uint8Array(44 + 48_000);
    const v = new DataView(wav.buffer);
    wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    wav.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8);
    v.setUint32(16, 16, true);
    v.setUint32(28, 48_000, true);
    wav.set([...'data'].map((c) => c.charCodeAt(0)), 36);
    v.setUint32(40, 48_000, true);
    expect(await audioLengthMs(new Blob([wav]))).toBe(1000);
    expect(await audioLengthMs(new Blob(['not audio at all']))).toBeUndefined();
  });

  it('measures a voice by its median time; this device speaks at once', () => {
    const [h] = hosts(1);
    const cloud = { ...h!, voice: { ...h!.voice, voiceProviderId: 'cloud-x' } };
    expect(voiceMs(cloud)).toBeUndefined();
    [900, 5000, 1100].forEach((ms) => noteVoiceMs(cloud, ms));
    expect(voiceMs(cloud)).toBe(1100);
    expect(voiceMs({ ...h!, voice: { ...h!.voice, voiceProviderId: 'device' } })).toBe(0);
  });
});
