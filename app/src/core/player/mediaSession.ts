// Lock screen / notification / hardware media keys: Media Session API on web, the native media notification on
// Android/iOS (core/native, no-op on web).
import { mediaNotification } from '../native';
import { artworkUrl } from '../services/artwork';
import type { Track } from '../types';

export interface MediaControls {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(ms: number): void;
  seekBy(deltaMs: number): void;
  stop(): void;
}

export interface MediaSessionInfo {
  /** where playback is now (native notification progress) */
  positionMs?: number;
  /** live stream: no duration, no seeking */
  live?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  /** keep the native notification as it is (restoring a saved queue at start-up must not start the service) */
  webOnly?: boolean;
  /** stopped from the notification: take it down, keep the track paused */
  dismiss?: boolean;
  /** shown in the native notification instead of the album (why the song waits) */
  note?: string;
}

const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : undefined;

export function bindMediaSession(c: MediaControls): void {
  if (ms) {
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // action not supported by this browser
      }
    };
    set('play', () => c.play());
    set('pause', () => c.pause());
    set('stop', () => c.stop());
    set('nexttrack', () => c.next());
    set('previoustrack', () => c.prev());
    set('seekto', (d) => d.seekTime !== undefined && c.seek(d.seekTime * 1000));
    set('seekforward', (d) => c.seekBy((d.seekOffset ?? 10) * 1000));
    set('seekbackward', (d) => c.seekBy(-(d.seekOffset ?? 10) * 1000));
  }
  mediaNotification.on('play', () => c.play());
  mediaNotification.on('pause', () => c.pause());
  mediaNotification.on('next', () => c.next());
  mediaNotification.on('prev', () => c.prev());
  mediaNotification.on('seek', (e) => Number.isFinite(e.positionMs) && c.seek(e.positionMs));
  mediaNotification.on('stop', () => c.stop());
}

let lastKey = '';
/** newer calls win (artwork lookups are async) */
let seq = 0;
/** the player put up the native notification (so it may take it down again) */
let shown = false;

async function clearNotification(): Promise<void> {
  if (!shown) return;
  shown = false;
  await mediaNotification.clear().catch(() => undefined);
}

/**
 * Metadata + playing state for the current track. Cheap to call often (metadata only changes with the track).
 * No track = nothing to play: the lock screen entry and the native notification go away.
 */
export async function updateMediaSession(track: Track | undefined, playing: boolean, info: MediaSessionInfo = {}): Promise<void> {
  const mine = ++seq;
  const art = track ? await artworkUrl(track.artworkId).catch(() => undefined) : undefined;
  if (mine !== seq) return;
  if (ms) {
    const key = track ? `${track.id}|${track.title}|${track.artist}|${art ?? ''}` : '';
    if (key !== lastKey) {
      lastKey = key;
      ms.metadata =
        track && typeof MediaMetadata !== 'undefined'
          ? new MediaMetadata({
              title: track.title,
              artist: track.artist,
              album: track.album,
              artwork: art ? [{ src: art, sizes: '512x512' }] : [],
            })
          : null;
    }
    ms.playbackState = track ? (playing ? 'playing' : 'paused') : 'none';
  }
  if (info.webOnly) return;
  if (!track || info.dismiss) {
    await clearNotification();
    return;
  }
  shown = true;
  const live = info.live ?? track.source === 'stream';
  await mediaNotification
    .update(
      {
        title: track.title,
        artist: track.artist,
        album: info.note ?? track.album,
        artworkUrl: art,
        durationMs: live ? undefined : track.durationMs || undefined,
      },
      playing,
      {
        ...(info.positionMs != null && !live ? { positionMs: Math.max(0, Math.round(info.positionMs)) } : {}),
        ...(info.canPrev != null ? { canPrev: info.canPrev } : {}),
        ...(info.canNext != null ? { canNext: info.canNext } : {}),
      },
    )
    .catch(() => undefined);
}

export function updatePositionState(positionMs: number, durationMs: number, live: boolean): void {
  if (!ms?.setPositionState) return;
  try {
    if (live || !(durationMs > 0)) ms.setPositionState();
    else
      ms.setPositionState({
        duration: durationMs / 1000,
        position: Math.max(0, Math.min(positionMs, durationMs)) / 1000,
        playbackRate: 1,
      });
  } catch {
    // position outside duration while metadata settles
  }
}
