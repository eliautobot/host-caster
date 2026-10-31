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
  try {
    if (mode === 'over') player.duck(duck, 500);
    if (mode === 'anyapp') await audioFocus.duck();
    if (hooks.chime !== false && !signal?.aborted) {
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
      const line = lines[i]!;
      const host = byId.get(line.hostId) ?? b.hosts[0];
      const clip = await clipFor(clips[i]!, host ? () => speak(deviceStandIn(host), line.text) : undefined, b);
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
