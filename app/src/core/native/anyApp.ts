// "Any music app" mode (Android): follow what YouTube Music, Spotify or any other player is playing, so the
// hosts can talk between its songs. Needs notification access (Settings). iOS does not allow this: unsupported.
import { App } from '@capacitor/app';
import type { AnyAppTrack } from '../types';
import { createEmitter } from '../util/emitter';
import { HostCasterAudio, type AnyAppStateEvent, type RawAnyAppNowPlaying } from './plugin';
import { hasPlugin, platform } from './platform';

export type { AnyAppStateEvent };

/** The track another app is playing. */
export interface AnyAppNowPlaying extends AnyAppTrack {
  /** stable id of the track (app + title + artist) */
  key: string;
  /** small JPEG data: URL when the app shares cover art */
  artworkUrl?: string;
  playing: boolean;
  positionMs: number;
  /** epoch ms when positionMs was read */
  at: number;
}

interface AnyAppEvents {
  /** a NEW track started in the app that is playing (fires once per track) */
  trackchange: AnyAppNowPlaying;
  /** more details for the current track arrived (cover art, album) */
  trackupdate: AnyAppNowPlaying;
  /** play / pause / seek / buffering of that app */
  playstate: AnyAppStateEvent;
}

const events = createEmitter<AnyAppEvents>();
let listening = false;
let lastKey = '';
let subscribers = 0;
const ready = () => platform === 'android' && hasPlugin('HostCasterAudio');

function toTrack(r: RawAnyAppNowPlaying | undefined): AnyAppNowPlaying | undefined {
  if (!r || !r.key) return undefined;
  return {
    key: r.key,
    packageName: r.packageName ?? '',
    appName: r.appName ?? r.packageName ?? '',
    title: r.title ?? '',
    artist: r.artist ?? '',
    ...(r.album ? { album: r.album } : {}),
    ...(r.durationMs ? { durationMs: r.durationMs } : {}),
    ...(r.artworkUrl ? { artworkUrl: r.artworkUrl } : {}),
    playing: r.playing,
    positionMs: r.positionMs ?? 0,
    at: r.at ?? Date.now(),
  };
}

function onTrack(raw: RawAnyAppNowPlaying): void {
  const t = toTrack(raw);
  if (!t) return;
  if (t.key === lastKey) {
    events.emit('trackupdate', t);
    return;
  }
  lastKey = t.key;
  events.emit('trackchange', t);
}

function listen(): void {
  if (listening || !ready()) return;
  listening = true;
  void HostCasterAudio.addListener('anyAppTrack', onTrack);
  void HostCasterAudio.addListener('anyAppState', (s) => events.emit('playstate', s));
}

/** Resolves on the next return to the app (after the user visited a Settings screen), or after `ms`. */
function nextResume(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let handle: { remove: () => Promise<void> } | undefined;
    const done = () => {
      clearTimeout(timer);
      void handle?.remove();
      resolve();
    };
    const timer = setTimeout(done, ms);
    void App.addListener('resume', done).then((h) => {
      handle = h;
    });
  });
}

export const anyApp = {
  /** Android only (iOS has no API to read other apps' playback). */
  available: platform === 'android',

  async hasPermission(): Promise<boolean> {
    if (!ready()) return false;
    return (await HostCasterAudio.anyAppStatus()).access;
  },

  /**
   * Opens Android's notification access screen for Host-Caster and resolves when the user comes back:
   * true if access is now on. (Sideloaded installs on Android 13+ first need App info > Allow restricted settings.)
   */
  async requestPermission(): Promise<boolean> {
    if (!ready()) return false;
    if (await anyApp.hasPermission()) return true;
    const back = nextResume(10 * 60 * 1000);
    await HostCasterAudio.openSettings({ target: 'anyapp' });
    await back;
    return anyApp.hasPermission();
  },

  /**
   * Start following other apps (subscribing with on() starts it too). Returns what is playing right now
   * (undefined when nothing is, or without access).
   */
  async start(): Promise<AnyAppNowPlaying | undefined> {
    if (!ready()) return undefined;
    listen();
    const r = await HostCasterAudio.anyAppStart();
    // the native side reports the current track as a trackchange right after starting
    return r.running ? toTrack(r.nowPlaying) : undefined;
  },

  async stop(): Promise<void> {
    if (!ready()) return;
    lastKey = '';
    await HostCasterAudio.anyAppStop();
  },

  async nowPlaying(): Promise<AnyAppNowPlaying | undefined> {
    if (!ready()) return undefined;
    return toTrack(await HostCasterAudio.anyAppNowPlaying());
  },

  /** Remote control of the app that is playing (pause before a long break, skip, ...). */
  async control(action: 'play' | 'pause' | 'next' | 'prev' | 'seek', positionMs?: number): Promise<boolean> {
    if (!ready()) return false;
    return (await HostCasterAudio.anyAppControl({ action, ...(positionMs != null ? { positionMs } : {}) })).ok;
  },

  /** Subscribing starts following other apps (when access is on); the last unsubscribe stops it. */
  on<E extends keyof AnyAppEvents>(event: E, cb: (e: AnyAppEvents[E]) => void): () => void {
    const off = events.on(event, cb);
    if (!ready()) return off;
    listen();
    if (subscribers++ === 0) void anyApp.start().catch(() => undefined);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      if (--subscribers === 0) void anyApp.stop().catch(() => undefined);
    };
  },
};
