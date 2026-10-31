// Spotify Connect remote control: Host-Caster tells one of the user's Spotify devices (phone app, desktop app,
// speaker) what to play and polls its state, so the radio knows when the song ends and can break in.
// Needs Spotify Premium (the Web API refuses playback control otherwise).
import type { AdapterEvents, PlayerAdapter, Track } from '../../types';
import { adapterEmitter, clamp01, rampSteps } from '../adapterkit';
import { SpotifyApiError, spotifyApi, type SpotifyRequest } from './api';

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted?: boolean;
  is_private_session?: boolean;
  volume_percent?: number | null;
  supports_volume?: boolean;
}

export interface PlaybackState {
  device?: SpotifyDevice;
  is_playing: boolean;
  progress_ms: number | null;
  item?: { uri: string; duration_ms: number; name?: string } | null;
  currently_playing_type?: string;
  repeat_state?: string;
}

type ApiFn = <T>(path: string, req?: SpotifyRequest) => Promise<T>;

export interface ConnectOptions {
  api?: ApiFn;
  /** preferred device id (Settings); else the active device, else the first usable one */
  preferredDevice?: () => Promise<string | undefined>;
  pollPlayingMs?: number;
  pollPausedMs?: number;
}

export async function listSpotifyDevices(api: ApiFn = spotifyApi): Promise<SpotifyDevice[]> {
  const r = await api<{ devices?: SpotifyDevice[] }>('/me/player/devices');
  return (r?.devices ?? []).filter((d) => d.id && !d.is_restricted);
}

/** What the end detector decides from one poll. */
export type ConnectVerdict = 'ended' | 'playing' | 'paused' | 'away';

/**
 * Pure end detection (unit-tested): our track finished when the device moved on to another item, stopped at
 * position 0 after being near the end, or stopped within a second of the end.
 */
export function judgeState(
  s: PlaybackState | undefined,
  ours: { uri: string; durationMs: number; lastProgressMs: number; startedAt: number },
  now = Date.now(),
): ConnectVerdict {
  const settling = now - ours.startedAt < 4000;
  if (!s || !s.item) {
    if (settling) return 'paused';
    return ours.lastProgressMs >= ours.durationMs - 5000 ? 'ended' : 'paused';
  }
  const duration = s.item.duration_ms || ours.durationMs;
  if (s.item.uri !== ours.uri) return settling ? 'paused' : ours.lastProgressMs >= duration - 8000 ? 'ended' : 'away';
  const progress = s.progress_ms ?? 0;
  if (!s.is_playing) {
    if (progress >= duration - 1000) return 'ended';
    if (progress === 0 && ours.lastProgressMs >= duration - 5000) return 'ended';
    return 'paused';
  }
  return 'playing';
}

export class SpotifyConnectAdapter implements PlayerAdapter {
  readonly id = 'spotify-connect';
  private em = adapterEmitter();
  private api: ApiFn;
  private track?: Track;
  private deviceId?: string;
  private started = false;
  private startedAt = 0;
  private wantPlaying = false;
  private lastProgress = 0;
  private lastPollAt = 0;
  private lastPlaying = false;
  private durationMs = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private endTimer?: ReturnType<typeof setTimeout>;
  private pendingSeek = 0;
  private vol = 1;
  private volumeSupported = true;
  /** last volume_percent we sent; undefined = we never touched the device's own volume */
  private sentVolume?: number;
  private cancelRamp: () => void = () => {};
  private ended = false;

  constructor(private opts: ConnectOptions = {}) {
    this.api = opts.api ?? spotifyApi;
  }

  canPlay(track: Track): boolean {
    return track.source === 'spotify';
  }

  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void {
    return this.em.on(event, cb);
  }

  /** Which device we are driving (for the UI). */
  get device(): string | undefined {
    return this.deviceId;
  }

  async load(track: Track): Promise<void> {
    this.stopTimers();
    this.track = track;
    this.started = false;
    this.ended = false;
    this.lastProgress = 0;
    this.pendingSeek = 0;
    this.durationMs = track.durationMs;
    this.em.emit('time', { positionMs: 0, durationMs: this.durationMs });
  }

  private async pickDevice(): Promise<string> {
    const devices = await listSpotifyDevices(this.api);
    const preferred = await this.opts.preferredDevice?.();
    const dev =
      devices.find((d) => d.id === preferred) ?? devices.find((d) => d.is_active) ?? devices[0];
    if (!dev?.id) {
      throw new SpotifyApiError(404, 'No Spotify device found. Open Spotify on your phone or computer, then press play.', 'NO_ACTIVE_DEVICE');
    }
    this.volumeSupported = dev.supports_volume !== false;
    return dev.id;
  }

  async play(): Promise<void> {
    if (!this.track) return;
    this.wantPlaying = true;
    try {
      if (!this.started) {
        this.deviceId ??= await this.pickDevice();
        try {
          await this.startOn(this.deviceId);
        } catch (err) {
          // the saved device went away: pick again once
          if (err instanceof SpotifyApiError && err.status === 404) {
            this.deviceId = await this.pickDevice();
            await this.startOn(this.deviceId);
          } else throw err;
        }
        this.started = true;
        this.startedAt = Date.now();
        void this.api('/me/player/repeat', { method: 'PUT', query: { state: 'off', device_id: this.deviceId } }).catch(() => undefined);
        // a duck or unduck that landed between songs: bring the device to where the radio wants it
        if (this.sentVolume !== undefined && this.sentVolume !== Math.round(this.vol * 100)) this.setRemoteVolume(this.vol);
      } else {
        await this.api('/me/player/play', { method: 'PUT', query: { device_id: this.deviceId } });
      }
    } catch (err) {
      this.wantPlaying = false;
      const e = err instanceof Error ? err : new Error(String(err));
      this.em.emit('error', e);
      throw e;
    }
    this.lastPlaying = true;
    this.lastPollAt = Date.now();
    this.em.emit('play', undefined);
    this.schedulePoll(this.opts.pollPlayingMs ?? 3000);
    this.startTicker();
  }

  private async startOn(deviceId: string) {
    await this.api('/me/player/play', {
      method: 'PUT',
      query: { device_id: deviceId },
      body: { uris: [this.track!.ref], position_ms: this.pendingSeek || 0 },
    });
    this.lastProgress = this.pendingSeek;
  }

  pause(): void {
    this.wantPlaying = false;
    this.stopTicker();
    if (this.started) void this.api('/me/player/pause', { method: 'PUT', query: { device_id: this.deviceId } }).catch(() => undefined);
    this.lastPlaying = false;
    this.em.emit('pause', undefined);
    this.schedulePoll(this.opts.pollPausedMs ?? 5000);
  }

  seek(ms: number): void {
    const pos = Math.max(0, Math.round(ms));
    if (!this.started) {
      this.pendingSeek = pos;
      return;
    }
    this.lastProgress = pos;
    this.lastPollAt = Date.now();
    void this.api('/me/player/seek', { method: 'PUT', query: { position_ms: pos, device_id: this.deviceId } }).catch(() => undefined);
    this.em.emit('time', { positionMs: pos, durationMs: this.durationMs });
    this.scheduleEndCheck();
  }

  volume(level: number): void {
    this.cancelRamp();
    this.setRemoteVolume(level);
  }

  /** Connect volume is an HTTP call per step, so ramps use 3 steps at most. */
  rampVolume(level: number, ms: number): void {
    this.cancelRamp();
    this.cancelRamp = rampSteps(this.vol, clamp01(level), ms, (v) => this.setRemoteVolume(v), 3);
  }

  private setRemoteVolume(level: number) {
    this.vol = clamp01(level);
    // between songs (not started yet) only remember it: play() sends it once the next song runs
    if (!this.started || !this.volumeSupported) return;
    const percent = Math.round(this.vol * 100);
    if (percent === this.sentVolume) return; // one HTTP call per real change
    this.sentVolume = percent;
    void this.api('/me/player/volume', {
      method: 'PUT',
      query: { volume_percent: percent, device_id: this.deviceId },
    }).catch((err: unknown) => {
      if (err instanceof SpotifyApiError && (err.reason === 'VOLUME_CONTROL_DISALLOW' || err.status === 403)) this.volumeSupported = false;
    });
  }

  unload(): void {
    this.stopTimers();
    if (this.started && this.wantPlaying) void this.api('/me/player/pause', { method: 'PUT', query: { device_id: this.deviceId } }).catch(() => undefined);
    this.started = false;
    this.wantPlaying = false;
    this.track = undefined;
  }

  // -- polling ---------------------------------------------------------------------------------------------------

  private schedulePoll(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    if (!this.track || this.ended) return;
    this.timer = setTimeout(() => void this.poll(), ms);
  }

  private scheduleEndCheck() {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (!this.wantPlaying || !this.durationMs) return;
    const left = this.durationMs - this.estimate();
    this.endTimer = setTimeout(() => void this.poll(), Math.max(250, left + 400));
  }

  private estimate(): number {
    if (!this.lastPlaying) return this.lastProgress;
    return Math.min(this.durationMs || Infinity, this.lastProgress + (Date.now() - this.lastPollAt));
  }

  private startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.lastPlaying) this.em.emit('time', { positionMs: this.estimate(), durationMs: this.durationMs });
    }, 500);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private stopTimers() {
    this.stopTicker();
    this.cancelRamp();
    if (this.timer) clearTimeout(this.timer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.timer = this.endTimer = undefined;
  }

  /** One poll of GET /me/player. Public for tests. */
  async poll(): Promise<ConnectVerdict | undefined> {
    const track = this.track;
    if (!track || !this.started || this.ended) return undefined;
    let s: PlaybackState | undefined;
    try {
      s = await this.api<PlaybackState | undefined>('/me/player', { query: { additional_types: 'track' } });
    } catch (err) {
      this.schedulePoll(5000); // transient (network, 429 already retried); keep trying
      if (err instanceof SpotifyApiError && err.status === 401) this.em.emit('error', err);
      return undefined;
    }
    if (track !== this.track) return undefined;
    const verdict = judgeState(s, { uri: track.ref, durationMs: this.durationMs, lastProgressMs: this.estimate(), startedAt: this.startedAt });
    if (s?.item?.uri === track.ref) {
      if (s.item.duration_ms) this.durationMs = s.item.duration_ms;
      this.lastProgress = s.progress_ms ?? this.lastProgress;
      this.lastPollAt = Date.now();
    }
    switch (verdict) {
      case 'ended':
      case 'away': {
        this.ended = true;
        this.stopTimers();
        // the device may have rolled on into Spotify autoplay: stop it so the radio can take over
        if (s?.is_playing) void this.api('/me/player/pause', { method: 'PUT', query: { device_id: this.deviceId } }).catch(() => undefined);
        this.wantPlaying = false;
        this.lastPlaying = false;
        this.em.emit('time', { positionMs: this.durationMs, durationMs: this.durationMs });
        this.em.emit('ended', undefined);
        return verdict;
      }
      case 'paused':
        if (this.lastPlaying && Date.now() - this.startedAt > 4000) {
          // paused on the phone / speaker
          this.lastPlaying = false;
          this.wantPlaying = false;
          this.stopTicker();
          this.em.emit('pause', undefined);
        }
        this.schedulePoll(this.opts.pollPausedMs ?? 5000);
        break;
      case 'playing':
        if (!this.lastPlaying) {
          this.lastPlaying = true;
          this.wantPlaying = true;
          this.startTicker();
          this.em.emit('play', undefined);
        }
        this.em.emit('time', { positionMs: this.lastProgress, durationMs: this.durationMs });
        this.schedulePoll(this.opts.pollPlayingMs ?? 3000);
        this.scheduleEndCheck();
        break;
    }
    return verdict;
  }
}
