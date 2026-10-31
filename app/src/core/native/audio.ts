// Background playback surface (media notification, lock screen, headset buttons) and audio focus.
// Android: foreground media service + MediaSession; iOS: Now Playing info + remote commands + AVAudioSession.
// Web: no-ops (the player sets navigator.mediaSession itself).
import type { MediaMeta } from '../types';
import { createEmitter } from '../util/emitter';
import { HostCasterAudio, type FocusState, type MediaActionEvent } from './plugin';
import { hasPlugin, isNative } from './platform';

const ready = () => hasPlugin('HostCasterAudio');

const EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const audioFocus = {
  /**
   * Before a host speaks over ANOTHER app's music (any-app mode): Android requests transient focus with
   * "may duck" so that app lowers its volume; iOS switches the audio session to duck others.
   * Returns 'own' when Host-Caster itself is the music (the player ducks in Web Audio instead).
   */
  async duck(): Promise<'granted' | 'own' | 'failed' | 'delayed' | 'unsupported'> {
    if (!ready()) return 'unsupported';
    try {
      return (await HostCasterAudio.duck()).result;
    } catch {
      return 'failed';
    }
  },
  /** After the break: give focus back so the other app returns to full volume. */
  async release(): Promise<void> {
    if (!ready()) return;
    await HostCasterAudio.releaseFocus().catch(() => {});
  },
  /**
   * Plays a voice clip natively, under the duck from duck(). Use it for breaks over another app's music: a clip
   * played by the WebView (<audio>) takes full audio focus on Android and that app stops instead of ducking.
   * Resolves true when done; false when not available (web), so the caller can fall back to player.playVoice.
   */
  async playClip(clip: Blob, opts: { volume?: number } = {}): Promise<boolean> {
    if (!ready()) return false;
    const ext = EXT[clip.type.split(';')[0]!.trim().toLowerCase()] ?? 'mp3';
    await HostCasterAudio.playClip({ base64: await blobToBase64(clip), ext, volume: opts.volume ?? 1 });
    return true;
  },
  async stopClip(): Promise<void> {
    if (!ready()) return;
    await HostCasterAudio.stopClip().catch(() => {});
  },
};

export interface MediaNotificationOptions {
  /** current position; leave out to keep the native clock running for the same track (0 for a new one) */
  positionMs?: number;
  canPrev?: boolean;
  canNext?: boolean;
  /** Host-Caster plays the music itself (default true). false in any-app mode, where the notification only keeps
   * the radio alive in the background while another app plays. */
  ownAudio?: boolean;
}

interface MediaNotificationEvents {
  play: MediaActionEvent;
  pause: MediaActionEvent;
  next: MediaActionEvent;
  prev: MediaActionEvent;
  seek: MediaActionEvent;
  stop: MediaActionEvent;
  focus: { state: FocusState };
}

const mediaEvents = createEmitter<MediaNotificationEvents>();
let listening = false;
let lastArtSent: string | undefined;

function listen(): void {
  if (listening || !ready()) return;
  listening = true;
  void HostCasterAudio.addListener('media', (e) => mediaEvents.emit(e.action, e));
  void HostCasterAudio.addListener('focus', (e) => mediaEvents.emit('focus', e));
}

/** blob:, data: and same-origin artwork is not reachable from native code: send a small JPEG instead. */
async function artworkPayload(url: string | undefined): Promise<{ artworkKey?: string; artworkBase64?: string; artworkUrl?: string }> {
  if (!url) return {};
  if (url === lastArtSent) return { artworkKey: url };
  const remote = /^https?:/i.test(url) && (typeof location === 'undefined' || !url.startsWith(location.origin));
  if (remote) return { artworkKey: url, artworkUrl: url };
  try {
    const blob = await (await fetch(url)).blob();
    const base64 = await shrinkToJpeg(blob, 512);
    return base64 ? { artworkKey: url, artworkBase64: base64 } : {};
  } catch {
    return {};
  }
}

async function shrinkToJpeg(blob: Blob, max: number): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined;
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const data = canvas.toDataURL('image/jpeg', 0.85);
  return data.slice(data.indexOf(',') + 1);
}

export const mediaNotification = {
  available: isNative,
  /**
   * Show / refresh the notification (Android starts the foreground service on first call, which keeps music
   * going with the screen off). Call on track change, play/pause and seek; the system animates the progress.
   */
  async update(meta: MediaMeta, playing: boolean, opts: MediaNotificationOptions = {}): Promise<void> {
    if (!ready()) return;
    listen();
    const art = await artworkPayload(meta.artworkUrl);
    await HostCasterAudio.updateNowPlaying({
      title: meta.title,
      artist: meta.artist,
      ...(meta.album ? { album: meta.album } : {}),
      ...(meta.durationMs ? { durationMs: meta.durationMs } : {}),
      ...(opts.positionMs != null ? { positionMs: opts.positionMs } : {}),
      playing,
      canPrev: opts.canPrev ?? true,
      canNext: opts.canNext ?? true,
      ownAudio: opts.ownAudio ?? true,
      ...art,
    });
    if (art.artworkBase64 || art.artworkUrl) lastArtSent = art.artworkKey;
  },
  /** Nothing to play any more: remove the notification and stop the background service. */
  async clear(): Promise<void> {
    lastArtSent = undefined;
    if (!ready()) return;
    await HostCasterAudio.clearNowPlaying().catch(() => {});
  },
  /** play | pause | next | prev | seek | stop from the notification / lock screen / headset, focus changes. */
  on<E extends keyof MediaNotificationEvents>(event: E, cb: (e: MediaNotificationEvents[E]) => void): () => void {
    listen();
    return mediaEvents.on(event, cb);
  },
};
