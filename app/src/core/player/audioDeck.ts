// The HTML audio adapter: local files, music on the device, the server library, internet streams and Subsonic URLs.
// Each deck owns two elements: one routed through the Web Audio graph (same-origin/blob URLs) and one plain element
// for cross-origin URLs (radio streams send no CORS headers; routing them would play silence).
import { resolveTrackUrl } from '../services/resolve';
import type { AdapterEvents, PlayerAdapter, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { isRoutableUrl, rampParam, type AudioGraph } from './graph';

const PLAYABLE = new Set<Track['source']>(['local', 'server', 'stream', 'subsonic', 'device']);
const LOAD_TIMEOUT_MS = 20_000;

function makeElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  return el;
}

export class AudioDeck implements PlayerAdapter {
  private emitter = createEmitter<AdapterEvents>();
  private routedEl?: HTMLAudioElement;
  private directEl?: HTMLAudioElement;
  private gain?: GainNode;
  private el?: HTMLAudioElement;
  private track?: Track;
  /** the current element plays through the Web Audio graph (the player ducks it there) */
  routed = false;

  constructor(
    readonly id: string,
    private graph: AudioGraph | null,
  ) {}

  canPlay(track: Track): boolean {
    return PLAYABLE.has(track.source);
  }

  /** the element in use (tests, debug) */
  get element(): HTMLAudioElement | undefined {
    return this.el;
  }

  get gainValue(): number | undefined {
    return this.routed ? this.gain?.gain.value : this.el?.volume;
  }

  async load(track: Track): Promise<void> {
    const url = await resolveTrackUrl(track);
    const routable = Boolean(this.graph?.supported) && track.source !== 'stream' && isRoutableUrl(url);
    const el = routable ? this.routedElement() : this.directElement();
    const other = el === this.routedEl ? this.directEl : this.routedEl;
    if (other) release(other);
    this.el = el;
    this.routed = routable && Boolean(this.gain);
    this.track = track;
    el.src = url;
    el.load();
    await waitForMetadata(el, track.source === 'stream');
  }

  async play(): Promise<void> {
    if (!this.el) throw new Error('Nothing loaded');
    if (this.routed) await this.graph?.resume();
    await this.el.play();
  }

  pause(): void {
    this.el?.pause();
  }

  seek(ms: number): void {
    if (!this.el || !Number.isFinite(this.el.duration)) return;
    this.el.currentTime = Math.max(0, Math.min(ms / 1000, this.el.duration - 0.05));
  }

  get positionMs(): number {
    return this.el ? this.el.currentTime * 1000 : 0;
  }

  /** Routed: the deck's own gain (crossfades); plain: the full output level. */
  volume(level: number): void {
    if (this.routed && this.gain && this.graph?.ctx) {
      rampParam(this.graph.ctx, this.gain.gain, level, level, 0);
      if (this.el) this.el.volume = 1;
    } else if (this.el) {
      this.el.volume = clamp(level);
    }
  }

  /** Smooth gain ramp; only used while routed (plain elements are stepped by the player). */
  rampVolume(level: number, ms: number): void {
    if (this.routed && this.gain && this.graph?.ctx) rampParam(this.graph.ctx, this.gain.gain, this.gain.gain.value, level, ms);
    else this.volume(level);
  }

  unload(): void {
    for (const el of [this.routedEl, this.directEl]) if (el) release(el);
    this.el = undefined;
    this.track = undefined;
  }

  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  private routedElement(): HTMLAudioElement {
    if (!this.routedEl) {
      const el = makeElement();
      this.gain = this.graph?.route(el, 'music');
      this.wire(el);
      this.routedEl = el;
    }
    return this.routedEl;
  }

  private directElement(): HTMLAudioElement {
    if (!this.directEl) {
      const el = makeElement();
      this.wire(el);
      this.directEl = el;
    }
    return this.directEl;
  }

  private wire(el: HTMLAudioElement) {
    const mine = () => el === this.el;
    const time = () => {
      if (!mine()) return;
      const d = el.duration;
      const durationMs = Number.isFinite(d) && d > 0 ? d * 1000 : (this.track?.durationMs ?? 0);
      this.emitter.emit('time', { positionMs: el.currentTime * 1000, durationMs });
    };
    el.addEventListener('timeupdate', time);
    el.addEventListener('durationchange', time);
    el.addEventListener('play', () => mine() && this.emitter.emit('play', undefined));
    el.addEventListener('pause', () => mine() && !el.ended && this.emitter.emit('pause', undefined));
    el.addEventListener('ended', () => mine() && this.emitter.emit('ended', undefined));
    el.addEventListener('error', () => {
      if (!mine() || !el.getAttribute('src')) return;
      this.emitter.emit('error', new Error(mediaErrorText(el.error, this.track)));
    });
  }
}

function release(el: HTMLAudioElement) {
  el.pause();
  if (el.getAttribute('src')) {
    el.removeAttribute('src');
    el.load();
  }
}

function clamp(x: number) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function waitForMetadata(el: HTMLAudioElement, live: boolean): Promise<void> {
  if (el.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', ok);
      el.removeEventListener('error', bad);
      fn();
    };
    const ok = () => done(resolve);
    const bad = () => done(() => reject(new Error(mediaErrorText(el.error))));
    // live streams can take a while to send the first bytes; let play() keep waiting
    const timer = setTimeout(() => done(live ? resolve : () => reject(new Error('The song took too long to load'))), LOAD_TIMEOUT_MS);
    el.addEventListener('loadedmetadata', ok);
    el.addEventListener('error', bad);
  });
}

function mediaErrorText(err: MediaError | null, track?: Track): string {
  const name = track ? `"${track.title}"` : 'This song';
  switch (err?.code) {
    case 2:
      return `${name} could not be loaded (network error)`;
    case 3:
      return `${name} could not be decoded`;
    case 4:
      return `${name} is in a format this browser cannot play`;
    default:
      return `${name} could not be played`;
  }
}
