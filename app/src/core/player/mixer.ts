// Volume for every output. Routed decks get master + duck from the graph's gain nodes and only carry their own
// crossfade level; everything else (plain <audio>, YouTube, Spotify) gets master x duck x deck as one volume,
// stepped every 30 ms during ramps (or handed to adapter.rampVolume when the adapter has one).
import type { PlayerAdapter } from '../types';
import { AudioDeck } from './audioDeck';
import { rampParam, type AudioGraph } from './graph';
import { Level } from './level';

const TICK_MS = 30;

export interface MixerLevels {
  context?: AudioContextState;
  /** graph gain values right now */
  master?: number;
  music?: number;
  voice?: number;
  /** what the mixer is aiming for */
  volume: number;
  muted: boolean;
  duck: number;
  duckTarget: number;
  /** the active output: its own gain (routed) or element volume (plain) */
  deck?: number;
  routed: boolean;
}

export class Mixer {
  readonly master: Level;
  readonly duck = new Level(1);
  private decks = new Map<PlayerAdapter, Level>();
  private live = new Set<PlayerAdapter>();
  private timer?: ReturnType<typeof setInterval>;
  volume: number;
  muted = false;

  constructor(
    private graph: AudioGraph | null,
    volume = 0.85,
  ) {
    this.volume = volume;
    this.master = new Level(volume);
  }

  deck(a: PlayerAdapter): Level {
    let l = this.decks.get(a);
    if (!l) this.decks.set(a, (l = new Level(1)));
    return l;
  }

  routed(a: PlayerAdapter | undefined): boolean {
    return a instanceof AudioDeck && a.routed;
  }

  /** `a` is audible (playing or fading); keep its volume in sync */
  attach(a: PlayerAdapter): void {
    this.live.add(a);
    this.syncGraph();
    this.push(a, 0);
  }

  detach(a: PlayerAdapter): void {
    this.live.delete(a);
  }

  /** copy the current levels onto the graph (it is created lazily on the first routed load) */
  syncGraph(): void {
    const g = this.graph;
    if (!g?.ctx || !g.master || !g.music) return;
    rampParam(g.ctx, g.master.gain, this.master.value, this.master.target, this.master.remainingMs);
    rampParam(g.ctx, g.music.gain, this.duck.value, this.duck.target, this.duck.remainingMs);
  }

  setVolume(volume: number, muted = this.muted, ms = 120): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.muted = muted;
    this.rampMaster(this.muted ? 0 : this.volume, ms);
  }

  setDuck(level: number, ms: number): void {
    const from = this.duck.rampTo(level, ms);
    const g = this.graph;
    if (g?.ctx && g.music) rampParam(g.ctx, g.music.gain, from, this.duck.target, ms);
    this.pushAll(ms);
  }

  rampDeck(a: PlayerAdapter, level: number, ms: number): void {
    this.deck(a).rampTo(level, ms);
    if (this.routed(a)) {
      if (a.rampVolume) a.rampVolume(level, ms);
      else a.volume(level);
    } else this.push(a, ms);
  }

  setDeck(a: PlayerAdapter, level: number): void {
    this.deck(a).set(level);
    this.push(a, 0);
  }

  /** combined level for outputs outside the graph */
  outputLevel(a: PlayerAdapter, at?: 'target'): number {
    const pick = (l: Level) => (at === 'target' ? l.target : l.value);
    return pick(this.master) * pick(this.duck) * pick(this.deck(a));
  }

  levels(active?: PlayerAdapter): MixerLevels {
    const g = this.graph;
    return {
      context: g?.ctx?.state,
      master: g?.master?.gain.value,
      music: g?.music?.gain.value,
      voice: g?.voice?.gain.value,
      volume: this.volume,
      muted: this.muted,
      duck: round(this.duck.value),
      duckTarget: this.duck.target,
      deck: active instanceof AudioDeck ? active.gainValue : undefined,
      routed: this.routed(active),
    };
  }

  private rampMaster(level: number, ms: number) {
    const from = this.master.rampTo(level, ms);
    const g = this.graph;
    if (g?.ctx && g.master) rampParam(g.ctx, g.master.gain, from, level, ms);
    this.pushAll(ms);
  }

  private pushAll(ms: number) {
    for (const a of this.live) this.push(a, ms);
  }

  private push(a: PlayerAdapter, ms: number) {
    if (this.routed(a)) {
      a.volume(this.deck(a).value);
      return;
    }
    // service adapters that fade themselves get the end value once
    if (ms > 0 && a.rampVolume && !(a instanceof AudioDeck)) {
      a.rampVolume(this.outputLevel(a, 'target'), ms);
      return;
    }
    a.volume(this.outputLevel(a));
    if (ms > 0) this.startTicking();
  }

  private startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let moving = this.master.ramping || this.duck.ramping;
      for (const a of this.live) {
        if (this.routed(a) || (a.rampVolume && !(a instanceof AudioDeck))) continue;
        a.volume(this.outputLevel(a));
        moving ||= this.deck(a).ramping;
      }
      if (!moving) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, TICK_MS);
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
