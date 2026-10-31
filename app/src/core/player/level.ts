// An animated 0..1 value (linear ramps) that can be read at any time. Mirrors what the Web Audio gain nodes do, so
// outputs that are not on the audio graph (plain <audio>, YouTube, Spotify) can follow the same ramps.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Level {
  private from: number;
  private to: number;
  private start = 0;
  private dur = 0;

  constructor(value = 1) {
    this.from = value;
    this.to = value;
  }

  /** current value */
  get value(): number {
    return this.at(now());
  }

  /** where the ramp ends */
  get target(): number {
    return this.to;
  }

  /** still moving */
  get ramping(): boolean {
    return this.dur > 0 && now() < this.start + this.dur;
  }

  /** ms left in the ramp */
  get remainingMs(): number {
    return this.ramping ? this.start + this.dur - now() : 0;
  }

  at(t: number): number {
    if (this.dur <= 0 || t >= this.start + this.dur) return this.to;
    if (t <= this.start) return this.from;
    return this.from + (this.to - this.from) * ((t - this.start) / this.dur);
  }

  set(value: number): void {
    this.from = this.to = clamp01(value);
    this.dur = 0;
  }

  /** ramps from the current value; returns the starting value */
  rampTo(value: number, ms: number): number {
    const t = now();
    const cur = this.at(t);
    this.from = cur;
    this.to = clamp01(value);
    this.start = t;
    this.dur = Math.max(0, ms);
    if (this.dur === 0) this.from = this.to;
    return cur;
  }
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}
