// Spotify Web Playback SDK: plays Spotify inside this browser tab (desktop browsers, Premium only).
// https://developer.spotify.com/documentation/web-playback-sdk/reference
import { isNative } from '../../native';
import type { AdapterEvents, PlayerAdapter, Track } from '../../types';
import { adapterEmitter, clamp01, loadScriptOnce, rampSteps } from '../adapterkit';
import { SpotifyApiError, spotifyApi, type SpotifyRequest } from './api';
import { getSpotifyAccessToken } from './auth';
import { judgeState } from './connect';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

// -- minimal SDK typings ---------------------------------------------------------------------------------------------
export interface SdkTrack {
  uri: string;
  id: string | null;
  name: string;
  linked_from?: { uri: string | null; id: string | null };
}
export interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SdkTrack | null; previous_tracks: SdkTrack[]; next_tracks: SdkTrack[] };
}
export interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  activateElement?(): Promise<void>;
}
export interface SdkPlayerCtor {
  new (opts: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }): SdkPlayer;
}

/** Desktop browsers with EME (Widevine). Not in Android/iOS WebViews or mobile browsers. */
export function webPlaybackSupported(): boolean {
  if (isNative || typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!window.isSecureContext) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return false;
  return typeof navigator.requestMediaKeySystemAccess === 'function';
}

export class SpotifySdkError extends Error {
  override name = 'SpotifySdkError';
  constructor(
    message: string,
    readonly kind: 'premium' | 'unsupported' | 'auth' | 'playback',
  ) {
    super(message);
  }
}

type ApiFn = <T>(path: string, req?: SpotifyRequest) => Promise<T>;

export interface SdkOptions {
  api?: ApiFn;
  /** returns the Spotify.Player constructor (tests pass a fake) */
  loadSdk?: () => Promise<SdkPlayerCtor>;
  playerName?: string;
}

async function loadRealSdk(): Promise<SdkPlayerCtor> {
  const w = window as unknown as { Spotify?: { Player: SdkPlayerCtor } };
  if (!w.Spotify) await loadScriptOnce(SDK_URL, 20000, 'onSpotifyWebPlaybackSDKReady');
  if (!w.Spotify) throw new SpotifySdkError('Spotify player did not load.', 'unsupported');
  return w.Spotify.Player;
}

export class SpotifySdkAdapter implements PlayerAdapter {
  readonly id = 'spotify-sdk';
  private em = adapterEmitter();
  private api: ApiFn;
  private player?: SdkPlayer;
  private deviceId?: string;
  private ready?: Promise<string>;
  private track?: Track;
  private started = false;
  private startedAt = 0;
  private playing = false;
  private lastPos = 0;
  private duration = 0;
  private pendingSeek = 0;
  private ended = false;
  private ticker?: ReturnType<typeof setInterval>;
  private vol = 1;
  private cancelRamp: () => void = () => {};
  /** set when the account cannot use the SDK (non-Premium); the wrapper falls back to Connect */
  fatal?: SpotifySdkError;

  constructor(private opts: SdkOptions = {}) {
    this.api = opts.api ?? spotifyApi;
  }

  canPlay(track: Track): boolean {
    return track.source === 'spotify';
  }

  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void {
    return this.em.on(event, cb);
  }

  /** Creates and connects the in-page player once; resolves with its device id. */
  ensure(): Promise<string> {
    if (this.fatal) return Promise.reject(this.fatal);
    this.ready ??= (async () => {
      const Ctor = await (this.opts.loadSdk ?? loadRealSdk)();
      const player = new Ctor({
        name: this.opts.playerName ?? 'Host-Caster',
        getOAuthToken: (cb) => void getSpotifyAccessToken().then(cb, () => cb('')),
        volume: this.vol,
      });
      this.player = player;
      const id = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SpotifySdkError('Spotify player did not start.', 'unsupported')), 15000);
        const fail = (kind: SpotifySdkError['kind'], msg: string) => {
          clearTimeout(timer);
          const err = new SpotifySdkError(msg, kind);
          if (kind !== 'playback') this.fatal = err;
          reject(err);
          this.em.emit('error', err);
        };
        player.addListener('ready', ((p: { device_id: string }) => {
          clearTimeout(timer);
          resolve(p.device_id);
        }) as (x: never) => void);
        player.addListener('not_ready', (() => {
          this.deviceId = undefined;
        }) as (x: never) => void);
        player.addListener('account_error', (() =>
          fail('premium', 'Playing Spotify in the browser needs Spotify Premium.')) as (x: never) => void);
        player.addListener('initialization_error', ((p: { message: string }) =>
          fail('unsupported', `This browser cannot play Spotify (${p.message}).`)) as (x: never) => void);
        player.addListener('authentication_error', ((p: { message: string }) =>
          fail('auth', `Spotify sign-in problem: ${p.message}`)) as (x: never) => void);
        player.addListener('playback_error', ((p: { message: string }) =>
          this.em.emit('error', new SpotifySdkError(p.message || 'Spotify could not play this track.', 'playback'))) as (
          x: never,
        ) => void);
        player.addListener('player_state_changed', ((s: SdkState | null) => this.onState(s)) as (x: never) => void);
        void player.connect().then((ok) => {
          if (!ok) fail('unsupported', 'Spotify player could not connect.');
        });
      });
      this.deviceId = id;
      return id;
    })();
    this.ready.catch(() => {
      if (!this.fatal) this.ready = undefined; // retry later on transient failures
    });
    return this.ready;
  }

  async load(track: Track): Promise<void> {
    this.stopTicker();
    this.track = track;
    this.started = false;
    this.ended = false;
    this.lastPos = 0;
    this.pendingSeek = 0;
    this.duration = track.durationMs;
    this.em.emit('time', { positionMs: 0, durationMs: this.duration });
  }

  async play(): Promise<void> {
    if (!this.track) return;
    const deviceId = this.deviceId ?? (await this.ensure());
    await this.player?.activateElement?.().catch(() => undefined);
    try {
      if (!this.started) {
        await this.api('/me/player/play', {
          method: 'PUT',
          query: { device_id: deviceId },
          body: { uris: [this.track.ref], position_ms: this.pendingSeek || 0 },
        });
        this.started = true;
        this.startedAt = Date.now();
        void this.api('/me/player/repeat', { method: 'PUT', query: { state: 'off', device_id: deviceId } }).catch(() => undefined);
      } else {
        await this.player?.resume();
      }
    } catch (err) {
      if (err instanceof SpotifyApiError && err.reason === 'PREMIUM_REQUIRED') {
        this.fatal = new SpotifySdkError(err.message, 'premium');
      }
      const e = err instanceof Error ? err : new Error(String(err));
      this.em.emit('error', e);
      throw e;
    }
    this.playing = true;
    this.em.emit('play', undefined);
    this.startTicker();
  }

  pause(): void {
    this.playing = false;
    this.stopTicker();
    void this.player?.pause().catch(() => undefined);
    this.em.emit('pause', undefined);
  }

  seek(ms: number): void {
    const pos = Math.max(0, Math.round(ms));
    if (!this.started) {
      this.pendingSeek = pos;
      return;
    }
    this.lastPos = pos;
    void this.player?.seek(pos).catch(() => undefined);
    this.em.emit('time', { positionMs: pos, durationMs: this.duration });
  }

  volume(level: number): void {
    this.cancelRamp();
    this.setVol(level);
  }

  rampVolume(level: number, ms: number): void {
    this.cancelRamp();
    this.cancelRamp = rampSteps(this.vol, clamp01(level), ms, (v) => this.setVol(v));
  }

  private setVol(v: number) {
    this.vol = clamp01(v);
    // the SDK treats 0 as "mute"; keep a hair above so ducking curves stay smooth
    void this.player?.setVolume(Math.max(0.0001, this.vol)).catch(() => undefined);
  }

  unload(): void {
    this.stopTicker();
    this.cancelRamp();
    if (this.playing) void this.player?.pause().catch(() => undefined);
    this.playing = false;
    this.started = false;
    this.track = undefined;
  }

  private startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => {
      void this.player?.getCurrentState().then((s) => this.onState(s), () => undefined);
    }, 500);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Maps SDK state to our events and detects the end of the track. Public for tests. */
  onState(s: SdkState | null): void {
    const track = this.track;
    if (!track || !this.started || this.ended) return;
    const cur = s?.track_window.current_track;
    const isOurs = (t: SdkTrack | null | undefined) => Boolean(t && (t.uri === track.ref || t.linked_from?.uri === track.ref));
    const finishedOurs = s?.paused && s.position === 0 && s.track_window.previous_tracks.some(isOurs);
    const verdict = finishedOurs
      ? 'ended'
      : judgeState(
          s ? { is_playing: !s.paused, progress_ms: s.position, item: cur ? { uri: isOurs(cur) ? track.ref : cur.uri, duration_ms: s.duration } : null } : undefined,
          { uri: track.ref, durationMs: this.duration, lastProgressMs: this.lastPos, startedAt: this.startedAt },
        );
    if (s && isOurs(cur)) {
      this.lastPos = s.position;
      if (s.duration) this.duration = s.duration;
    }
    if (verdict === 'ended' || verdict === 'away') {
      this.ended = true;
      this.playing = false;
      this.stopTicker();
      if (s && !s.paused) void this.player?.pause().catch(() => undefined);
      this.em.emit('time', { positionMs: this.duration, durationMs: this.duration });
      this.em.emit('ended', undefined);
      return;
    }
    if (verdict === 'paused' && this.playing && Date.now() - this.startedAt > 2000) {
      this.playing = false;
      this.stopTicker();
      this.em.emit('pause', undefined);
    } else if (verdict === 'playing' && !this.playing) {
      this.playing = true;
      this.startTicker();
      this.em.emit('play', undefined);
    }
    this.em.emit('time', { positionMs: this.lastPos, durationMs: this.duration });
  }
}
