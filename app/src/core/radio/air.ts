// Airs a prepared break: ident chime, each host line with live captions, music ducked, optional talk over the
// next song's intro. Stops cleanly when the signal fires (Next pressed, station stopped).
import { audioFocus } from '../native';
import { player } from '../player';
import type { BreakLine, VoiceClip } from '../types';
import { playClip } from '../voice/voice';
import { stopDeviceSpeech } from '../voice/device';
import { identChime } from './chime';
import { deviceStandIn, type PreparedBreak } from './prepare';
import { speak } from '../voice/voice';
import { clipLengthMs, DRIFT_MS, fillTime, noteVoiceMs, relativeAt, SINGLE_LINE_WAIT_MS, TIME_TOLERANCE_MS, voiceMs } from './airtime';
import { spokenTime } from './speakable';

/** a voice this fast (this device's voice, or one measured this quick) says the time line again at its turn */
const REVOICE_MS = 600;

/**
 * hold = between two songs (player.holdAfterCurrent); over = over the music that is playing (call-ins, streams,
 * late breaks); anyapp = over another app's music using transient audio focus.
 */
export type AirMode = 'hold' | 'over' | 'anyapp';

export interface AirHooks {
  onLine(line: BreakLine, index: number): void;
  signal?: AbortSignal;
  /** play the station ident first */
  chime?: boolean;
}

/** the first line starts this long into the ident, while it rings out (a radio "sweeper") */
export const CHIME_LEAD_MS = 450;
/** a line whose clip is still on its way gets this long, then this device's voice reads it */
export const CLIP_WAIT_MS = 4000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Plays one clip. Over another app (any-app mode) audio clips go through the native player under the transient
 * duck (a WebView clip would take full focus and stop that app). Device speech is not on the player's voice
 * channel: keep the break alive while it talks.
 */
async function playWithActivity(clip: VoiceClip, lang: string | undefined, mode: AirMode): Promise<void> {
  if (clip.kind === 'audio') {
    if (mode === 'anyapp' && (await audioFocus.playClip(clip.blob))) return;
    return playClip(clip, lang);
  }
  const beat = setInterval(() => player.markActivity(), 2000);
  player.markActivity();
  try {
    await playClip(clip, lang);
  } finally {
    clearInterval(beat);
  }
}

/** The line's clip, or (still not there after CLIP_WAIT_MS) this device's voice for it. */
async function clipFor(clip: VoiceClip | Promise<VoiceClip>, standIn: (() => Promise<VoiceClip>) | undefined, b: PreparedBreak): Promise<VoiceClip> {
  if (!(clip instanceof Promise) || !standIn) return clip;
  player.markActivity();
  const got = await Promise.race([clip, new Promise<undefined>((r) => setTimeout(() => r(undefined), CLIP_WAIT_MS))]);
  if (got) return got;
  b.standIn ??= 'The voice took too long, so this device read a line';
  b.standInFor = { ...b.standInFor, voice: true };
  return standIn();
}

/** the pause between two lines (shorter when the same host goes on) */
const gapAfter = (lines: BreakLine[], i: number) => (i < lines.length - 1 ? (lines[i + 1]!.hostId === lines[i]!.hostId ? 150 : 260) : 0);

/** a clip's value if it is already there (no waiting) */
const settled = <T>(p: T | Promise<T>) => Promise.race([p, Promise.resolve(undefined)]);
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

interface Retimed {
  /** when the line is expected to start */
  at: number;
  text: string;
  clip: Promise<VoiceClip | undefined>;
}

/**
 * The break's real start: the time-teller's line gets the real time at the moment it will play (now + the ident +
 * the earlier lines' clips) and is voiced now, while the earlier lines play. A break airing a minute or more off its
 * plan (a skip, a pause, a fast-forward) also gets its "in N minutes" recounted and voiced again.
 */
export async function retimeAtAir(b: PreparedBreak, startedAt: number, leadInMs: number): Promise<Map<number, Retimed>> {
  const out = new Map<number, Retimed>();
  const tl = b.timeLine;
  const drift = startedAt - (b.airAt ?? startedAt);
  const fixes = Math.abs(drift) >= DRIFT_MS ? Object.keys(b.relative ?? {}).map(Number) : [];
  if (!tl && !fixes.length) return out;
  const byId = new Map(b.hosts.map((h) => [h.id, h]));
  const hostOf = (i: number) => byId.get(b.lines[i]!.hostId) ?? b.hosts[0]!;
  const starts: number[] = [];
  let t = startedAt + leadInMs;
  const upTo = Math.max(tl?.index ?? 0, ...fixes);
  for (let i = 0; i <= upTo && i < b.lines.length; i++) {
    starts.push(t);
    const ready = await settled(b.clips[i]!);
    t += (await clipLengthMs(ready, b.lines[i]!.text, hostOf(i).voice.speed)) + gapAfter(b.lines, i);
  }
  const voice = (i: number, text: string): Promise<VoiceClip | undefined> => {
    const host = hostOf(i);
    const t0 = Date.now();
    // a voice that fails gives this device's voice, like every other line (prepare.ts)
    return speak(host, text, { timeoutMs: Math.max(3000, starts[i]! - Date.now() + 2000) }).then(
      (clip) => (noteVoiceMs(host, Date.now() - t0), clip),
      () => speak(deviceStandIn(host), text).catch(() => undefined),
    );
  };
  for (const i of fixes) {
    if (i === tl?.index) continue;
    const text = relativeAt(b.lines[i]!.text, b.relative![i]!.rel, starts[i]!);
    if (text !== b.lines[i]!.text) out.set(i, { at: starts[i]!, text, clip: voice(i, text) });
  }
  if (tl) {
    const at = starts[tl.index]!;
    // a one-line break with a voice measured slower than its wait: the line voiced ahead plays at once
    const slow = tl.index === 0 && (voiceMs(hostOf(0)) ?? 0) > SINGLE_LINE_WAIT_MS;
    const text = relativeAt(fillTime(tl.template, at), tl.rel, at);
    if (!slow) out.set(tl.index, { at, text, clip: voice(tl.index, text) });
  }
  return out;
}

/**
 * What line `i` says: its retimed version when that is ready and still on time, else the version voiced ahead
 * (without the time; "at 2 PM" for "in 20 minutes"); null = skip it (a time-only line whose time is not ready).
 */
async function lineFor(b: PreparedBreak, i: number, retimed: Promise<Map<number, Retimed>>): Promise<{ text: string; clip: VoiceClip | Promise<VoiceClip> } | null | undefined> {
  const r = (await retimed).get(i);
  const tl = b.timeLine?.index === i ? b.timeLine : undefined;
  // this device's voice, or one measured very quick: the time line can be said again for the very moment
  const own = b.hosts.find((h) => h.id === b.lines[i]!.hostId) ?? b.hosts[0];
  // the host's voice failed while the break was voiced: this device's voice reads its lines (and is instant)
  const host = own && b.standInFor?.voice ? deviceStandIn(own) : own;
  const fast = tl && host && (voiceMs(host) ?? Infinity) <= REVOICE_MS;
  if (r) {
    const wait = tl && b.lines.length === 1 ? SINGLE_LINE_WAIT_MS - CHIME_LEAD_MS : i === 0 ? 800 : 300;
    const clip = await within(r.clip, wait);
    const now = Date.now();
    // the clock's own minute; else within the tolerance when it cannot be said again in time
    const onTime = tl ? spokenTime(r.at) === spokenTime(now) || (!fast && Math.abs(now - r.at) <= TIME_TOLERANCE_MS) : Math.abs(now - r.at) <= TIME_TOLERANCE_MS;
    if (clip && onTime) return { text: r.text, clip };
  }
  if (tl) {
    if (fast && host) {
      const at = Date.now() + (voiceMs(host) ?? 0);
      const text = relativeAt(fillTime(tl.template, at), tl.rel, at);
      const clip = await within(speak(host, text, { timeoutMs: REVOICE_MS * 2 }).catch(() => undefined), REVOICE_MS + 100);
      if (clip) return { text, clip };
    }
    console.info(`[hostcaster] time line said without the time ${JSON.stringify({ off: r ? Date.now() - r.at : null, fast, voiceMs: host ? voiceMs(host) : null, standIn: Boolean(b.standInFor?.voice) })}`);
    return tl.plain ? { text: tl.plain, clip: b.clips[i]! } : null;
  }
  const rel = b.relative?.[i];
  if (r && rel) return { text: rel.safe, clip: rel.safeClip };
  return undefined;
}

export async function airBreak(b: PreparedBreak, mode: AirMode, hooks: AirHooks): Promise<void> {
  const { station, lines, clips } = b;
  const duck = Math.max(0, Math.min(1, station.duckLevel ?? 0.18));
  const signal = hooks.signal;
  const byId = new Map(b.hosts.map((h) => [h.id, h]));
  const stop = () => {
    player.stopVoice();
    stopDeviceSpeech();
    if (mode === 'anyapp') void audioFocus.stopClip();
  };
  signal?.addEventListener('abort', stop);
  const chime = hooks.chime !== false;
  const retimed = retimeAtAir(b, Date.now(), chime ? (mode === 'anyapp' ? 120 : CHIME_LEAD_MS) : 0).catch(() => new Map<number, Retimed>());
  try {
    if (mode === 'over') player.duck(duck, 500);
    if (mode === 'anyapp') await audioFocus.duck();
    if (chime && !signal?.aborted) {
      const chime = identChime(`${station.id}:${station.frequency}`);
      if (mode === 'anyapp' && (await audioFocus.playClip(chime, { volume: 0.8 }))) await sleep(120, signal);
      else {
        // the host comes in over the ringing ident, not after it
        player.playSting(chime).catch(() => undefined);
        await sleep(CHIME_LEAD_MS, signal);
      }
    }
    const introAt = mode === 'hold' && station.talkOverIntro && b.plan.intro ? lines.length - 1 : -1;
    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) return;
      if (i === introAt) await player.introNext(duck);
      const pick = await lineFor(b, i, retimed);
      if (pick === null) {
        // nothing left to say without the time: the line is left out (and out of the log)
        lines[i] = { ...lines[i]!, text: '' };
        continue;
      }
      if (pick) lines[i] = { ...lines[i]!, text: pick.text };
      const line = lines[i]!;
      const host = byId.get(line.hostId) ?? b.hosts[0];
      const clip = await clipFor(pick ? pick.clip : clips[i]!, host ? () => speak(deviceStandIn(host), line.text) : undefined, b);
      if (signal?.aborted) return;
      hooks.onLine(line, i);
      await playWithActivity(clip, host?.language, mode);
      if (i < lines.length - 1) await sleep(lines[i + 1]!.hostId === line.hostId ? 150 : 260, signal);
    }
    // let the last word ring out before the music comes back up (a music service such as YouTube takes longer than
    // that to start the next song anyway, so it starts right away)
    const s = player.state;
    const service = ['youtube', 'spotify'].includes(s.queue[s.index + 1]?.source ?? '');
    await sleep(mode === 'hold' && introAt < 0 ? (service ? 0 : 250) : 120, signal);
  } finally {
    signal?.removeEventListener('abort', stop);
    if (mode === 'over') player.unduck(900);
    if (mode === 'anyapp') await audioFocus.release().catch(() => undefined);
  }
}
