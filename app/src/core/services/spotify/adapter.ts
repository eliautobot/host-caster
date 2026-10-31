// The player's Spotify adapter: Web Playback SDK in desktop browsers (Premium), otherwise Spotify Connect
// remote control of the user's own Spotify device. Re-emits the chosen backend's events.
import { kvGet, kvSet } from '../../db';
import type { AdapterEvents, PlayerAdapter, Track } from '../../types';
import { adapterEmitter } from '../adapterkit';
import { SpotifyConnectAdapter } from './connect';
import { SpotifySdkAdapter, SpotifySdkError, webPlaybackSupported } from './sdk';

export type SpotifyPlayMode = 'auto' | 'browser' | 'connect';

export interface SpotifyPrefs {
  mode: SpotifyPlayMode;
  /** Connect device to play on; empty = the active one */
  deviceId?: string;
  deviceName?: string;
}

const PREFS_KEY = 'spotify:prefs';

export async function getSpotifyPrefs(): Promise<SpotifyPrefs> {
  return (await kvGet<SpotifyPrefs>(PREFS_KEY))?.value ?? { mode: 'auto' };
}

export async function setSpotifyPrefs(patch: Partial<SpotifyPrefs>): Promise<SpotifyPrefs> {
  const next = { ...(await getSpotifyPrefs()), ...patch };
  await kvSet(PREFS_KEY, next);
  return next;
}

type Backend = SpotifySdkAdapter | SpotifyConnectAdapter;

export class SpotifyAdapter implements PlayerAdapter {
  readonly id = 'spotify';
  private em = adapterEmitter();
  readonly sdk: SpotifySdkAdapter;
  readonly connect: SpotifyConnectAdapter;
  private current?: Backend;
  private offs: (() => void)[] = [];
  private track?: Track;

  constructor(opts: { sdk?: SpotifySdkAdapter; connect?: SpotifyConnectAdapter; supported?: () => boolean } = {}) {
    this.sdk = opts.sdk ?? new SpotifySdkAdapter();
    this.connect =
      opts.connect ?? new SpotifyConnectAdapter({ preferredDevice: async () => (await getSpotifyPrefs()).deviceId });
    this.supported = opts.supported ?? webPlaybackSupported;
  }

  private supported: () => boolean;

  canPlay(track: Track): boolean {
    return track.source === 'spotify';
  }

  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void {
    return this.em.on(event, cb);
  }

  /** 'browser' | 'connect' for the current track (UI shows "Playing in this browser" / "on <device>"). */
  get backend(): 'browser' | 'connect' | undefined {
    return this.current === this.sdk ? 'browser' : this.current === this.connect ? 'connect' : undefined;
  }

  private async choose(): Promise<Backend> {
    const { mode } = await getSpotifyPrefs();
    if (mode === 'connect') return this.connect;
    if (mode === 'browser') return this.sdk;
    return this.supported() && !this.sdk.fatal ? this.sdk : this.connect;
  }

  private attach(b: Backend) {
    if (this.current === b) return;
    this.offs.forEach((off) => off());
    this.current?.unload();
    this.current = b;
    const events: (keyof AdapterEvents)[] = ['play', 'pause', 'ended', 'time', 'error'];
    this.offs = events.map((ev) => b.on(ev, (p) => this.em.emit(ev, p as never)));
  }

  async load(track: Track): Promise<void> {
    this.track = track;
    this.attach(await this.choose());
    await this.current!.load(track);
  }

  async play(): Promise<void> {
    if (!this.current || !this.track) return;
    try {
      await this.current.play();
    } catch (err) {
      // auto mode: no Premium / no EME in this browser -> drive the user's Spotify app instead
      const { mode } = await getSpotifyPrefs();
      if (this.current === this.sdk && mode === 'auto' && err instanceof SpotifySdkError && err.kind !== 'playback') {
        this.attach(this.connect);
        await this.connect.load(this.track);
        await this.connect.play();
        return;
      }
      throw err;
    }
  }

  pause(): void {
    this.current?.pause();
  }

  seek(ms: number): void {
    this.current?.seek(ms);
  }

  volume(level: number): void {
    this.current?.volume(level);
  }

  rampVolume(level: number, ms: number): void {
    this.current?.rampVolume(level, ms);
  }

  unload(): void {
    this.current?.unload();
  }
}
