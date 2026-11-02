// The time-teller on air, with a fake clock: the break is written 4 minutes before its song ends, then the listener
// skips, fast-forwards or pauses; the voice is fast or slow. The time said is always the real time when that line
// plays (within a minute), or no time at all, and there is never dead air waiting for it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BreakLine, Host, VoiceClip } from '../types';
import { estimateSpeechMs, planAirTime } from './airtime';
import { hosts, station } from './fixtures';
import type { PreparedBreak } from './prepare';
import { spokenTime } from './speakable';

const said: { text: string; at: number }[] = [];
const mixer: { what: string; at: number }[] = [];
const asked: { text: string; at: number }[] = [];
/** how long the voice takes for a line (ms) */
let voiceLatency = (_text: string) => 800;
/** how long a clip really plays, as a share of its estimated length */
let playScale = 1;

vi.mock('../player', () => ({
  player: {
    duck: () => void mixer.push({ what: 'duck', at: Date.now() }),
    unduck: () => void mixer.push({ what: 'unduck', at: Date.now() }),
    playSting: async () => undefined,
    introNext: async () => undefined,
    stopVoice: () => undefined,
    markActivity: () => undefined,
    state: { queue: [], index: 0 },
  },
}));
vi.mock('../native', () => ({ audioFocus: { duck: async () => undefined, playClip: async () => false, stopClip: async () => undefined, release: async () => undefined } }));
vi.mock('../voice/device', () => ({ stopDeviceSpeech: () => undefined }));
vi.mock('./chime', () => ({ identChime: () => new Blob() }));
vi.mock('./prepare', () => ({ deviceStandIn: (h: Host) => h }));
vi.mock('../voice/voice', () => ({
  speak: async (_h: Host, text: string): Promise<VoiceClip> => {
    asked.push({ text, at: Date.now() });
    await new Promise((r) => setTimeout(r, voiceLatency(text)));
    return { kind: 'device', text, voiceId: '', rate: 1, pitch: 1 };
  },
  // a clip plays as long as it takes to say
  playClip: async (clip: VoiceClip) => {
    const text = clip.kind === 'device' ? clip.text : '';
    said.push({ text, at: Date.now() });
    await new Promise((r) => setTimeout(r, estimateSpeechMs(text) * playScale));
  },
}));

const { airBreak } = await import('./air');

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 1, h, m, s).getTime();
const [maya, jules] = hosts(2).map((h) => ({ ...h, voice: { ...h.voice, voiceProviderId: 'cloud-voice', voiceId: 'x' } })) as [Host, Host];
const device = (text: string): VoiceClip => ({ kind: 'device', text, voiceId: '', rate: 1, pitch: 1 });
const Q4 = at(9, 44);

/** A break written at 9:20 for 9:24 (its song ends in 4 minutes), the way prepare.ts readies it. */
function written(lines: BreakLine[], airAt = at(9, 24), next: { title: string; artist: string } | null = { title: 'Harbor Lights', artist: 'Tide Machine' }): PreparedBreak {
  const timed = planAirTime(lines, {
    wantTime: true,
    next: next ?? undefined,
    airAt,
    packet: { calendar: [{ id: 'q4', title: 'Q4 review', start: Q4, calendar: 'Work', allDay: false, source: 'google' as const }] },
    stationName: 'Wave FM',
  });
  const relIdx = Object.keys(timed.relative).map(Number);
  return {
    station: station(),
    hosts: [maya, jules],
    plan: { kind: 'regular', topics: ['time'], items: [{ segment: 'time', key: 'time' }], lines: lines.length, outro: false, intro: false, mix: 3 },
    packet: {} as PreparedBreak['packet'],
    lines: timed.lines,
    clips: timed.voiced.map((l) => device(l.text)),
    mode: 'script',
    tookMs: 0,
    airAt,
    ...(timed.timeLine ? { timeLine: timed.timeLine } : {}),
    ...(relIdx.length ? { relative: Object.fromEntries(relIdx.map((i) => [i, { ...timed.relative[i]!, safeClip: Promise.resolve(device(timed.relative[i]!.safe)) }])) } : {}),
  };
}

const THREE = [
  { hostId: maya.id, text: 'That was Midnight City by M83, what a way to start the morning.' },
  { hostId: jules.id, text: 'Heads up, your Q4 review with Dana starts in twenty minutes, so grab those vendor quotes.' },
  { hostId: maya.id, text: "It's {TIME} on this Sunday morning, here's Harbor Lights by Tide Machine." },
];

/** Airs the break starting at `start`; returns what was said and when. */
async function airAt(b: PreparedBreak, start: number) {
  vi.setSystemTime(start);
  said.length = 0;
  asked.length = 0;
  const done = airBreak(b, 'hold', { onLine: () => undefined });
  await vi.runAllTimersAsync();
  await done;
  return said.filter((s) => s.text);
}

/** The time a line says ("nine twenty-four") must be the clock's time when it plays, within a minute. */
function expectRightTime(line: { text: string; at: number }) {
  const ok = [line.at, line.at - 60_000, line.at + 60_000].map((t) => spokenTime(t));
  expect(ok.some((w) => line.text.toLowerCase().includes(w))).toBe(true);
}

describe('the time-teller on air (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    voiceLatency = () => 800;
    playScale = 1;
  });
  afterEach(() => vi.useRealTimers());

  it('on time: the last line says the real time when it plays, voiced at break start', async () => {
    const out = await airAt(written(THREE), at(9, 24));
    expect(out).toHaveLength(3);
    expect(out[2]!.text).toMatch(/^It's nine twenty-four on this Sunday morning, here's Harbor Lights/);
    expectRightTime(out[2]!);
    // voiced when the break started, not when it was written
    expect(asked.find((a) => a.text.includes('twenty-four'))!.at).toBe(at(9, 24));
    // no other line mentions the clock
    expect(out.slice(0, 2).some((l) => /nine|o'clock/.test(l.text))).toBe(false);
  });

  it('a skip (the break airs 2.5 minutes early) and a fast-forward (1 minute early)', async () => {
    const skip = await airAt(written(THREE), at(9, 21, 30));
    expect(skip[2]!.text).toContain('nine twenty-one');
    expectRightTime(skip[2]!);
    // "in twenty minutes" was written for 9:24: recounted for when it is said
    expect(skip[1]!.text).toContain('in twenty-two minutes');
    const ff = await airAt(written(THREE), at(9, 22, 55));
    expectRightTime(ff[2]!);
    // said at 9:23:00
    expect(ff[1]!.text).toContain('in twenty-one minutes');
  });

  it('a 6 minute pause: the time and the "in N minutes" are right for 9:30', async () => {
    const out = await airAt(written(THREE), at(9, 30));
    expect(out[2]!.text).toContain('nine thirty');
    expectRightTime(out[2]!);
    expect(out[1]!.text).toContain('in fourteen minutes');
  });

  it('a slow voice: the time line plays without the time, the stale "in N minutes" becomes the event time', async () => {
    voiceLatency = (text) => (/nine|fourteen/.test(text) ? 60_000 : 800);
    const out = await airAt(written(THREE), at(9, 30));
    expect(out).toHaveLength(3);
    expect(out[1]!.text).toContain('starts at 9:44 AM');
    expect(out[2]!.text).toBe("Here's Harbor Lights by Tide Machine.");
    // no dead air: each line follows the one before within a second (plus its length)
    for (let i = 1; i < out.length; i++) expect(out[i]!.at - out[i - 1]!.at - estimateSpeechMs(out[i - 1]!.text)).toBeLessThan(1000);
  });

  it('a one-line break: voiced at the start; a slow voice gives the line voiced ahead after a short wait', async () => {
    const one = [{ hostId: maya.id, text: "It's {TIME}, here's Harbor Lights by Tide Machine." }];
    const fast = await airAt(written(one), at(9, 26));
    expect(fast[0]!.text).toContain('nine twenty-six');
    expectRightTime(fast[0]!);
    voiceLatency = (text) => (/nine/.test(text) ? 30_000 : 800);
    const slow = await airAt(written(one), at(9, 26));
    expect(slow[0]!.text).toBe("Here's Harbor Lights by Tide Machine.");
    expect(slow[0]!.at - at(9, 26)).toBeLessThanOrEqual(2600);
  });

  it('a time-only last line that is not ready is left out (never a wrong time)', async () => {
    voiceLatency = (text) => (/nine/.test(text) ? 60_000 : 800);
    // a call-in style break: no song to hand off to
    const b = written([THREE[0]!, { hostId: jules.id, text: "And it's {TIME}." }], at(9, 24), null);
    const out = await airAt(b, at(9, 24));
    expect(out).toHaveLength(1);
    expect(b.lines.filter((l) => l.text)).toHaveLength(1);
  });

  it('a heads-up break-in over the music: ducked before the host speaks, back up after the last word', async () => {
    const text = 'Quick heads-up: the Q4 budget review at 2 PM was just cancelled.';
    const b = { ...written([{ hostId: maya.id, text }]), timeLine: undefined, relative: undefined, plan: { kind: 'headsup', topics: ['headsUp'], items: [], lines: 1, outro: false, intro: false, mix: 0 } } as PreparedBreak;
    b.lines = [{ hostId: maya.id, text }];
    b.clips = [device(text)];
    mixer.length = 0;
    vi.setSystemTime(at(13, 20));
    said.length = 0;
    const done = airBreak(b, 'over', { onLine: () => undefined });
    await vi.runAllTimersAsync();
    await done;
    expect(said.map((x) => x.text)).toEqual([text]);
    expect(mixer.map((m) => m.what)).toEqual(['duck', 'unduck']);
    // the host comes in over the ident ~0.5 s after the duck; the music comes back after the line
    expect(said[0]!.at - mixer[0]!.at).toBeGreaterThanOrEqual(400);
    expect(mixer[1]!.at).toBeGreaterThanOrEqual(said[0]!.at + estimateSpeechMs(text));
  });

  it("this device's voice: lines far shorter than measured, the time line is said again for its real moment", async () => {
    const local = { ...maya, voice: { ...maya.voice, voiceProviderId: 'device' } };
    const b = { ...written(THREE), hosts: [local, jules] };
    b.lines = b.lines.map((l) => ({ ...l, hostId: l.hostId === maya.id ? local.id : l.hostId }));
    // a headless or very fast voice: each line done in a tenth of its length (the planned moment is ~25 s off)
    playScale = 0.1;
    voiceLatency = () => 0;
    const out = await airAt(b, at(9, 24, 50));
    expect(out[2]!.text).toMatch(/^It's nine twenty-four/);
    expectRightTime(out[2]!);
  });

  it('every scenario: the time said always equals the real time when it plays', async () => {
    for (const start of [at(9, 24), at(9, 20, 5), at(9, 23, 59), at(9, 30), at(9, 59, 50), at(10, 0, 0)]) {
      const out = await airAt(written(THREE), start);
      const timed = out.find((l) => /nine|ten/i.test(l.text) && /Harbor/.test(l.text));
      if (timed) expectRightTime(timed);
    }
  });
});
