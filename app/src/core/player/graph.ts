// One Web Audio graph for the whole app:
//   deck A gain ─┐
//   deck B gain ─┴─ music gain (duck) ─┐
//                       voice gain ────┴─ master gain (volume, mute) ─ destination
// Only same-origin / blob sources are routed here (cross-origin media without CORS would play silence).

type Ctx = AudioContext;

const AudioCtx: typeof AudioContext | undefined =
  typeof window !== 'undefined'
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;

export class AudioGraph {
  ctx?: Ctx;
  master?: GainNode;
  music?: GainNode;
  voice?: GainNode;
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  /** called once the context exists (the mixer copies its levels onto the new gain nodes) */
  onCreate?: () => void;

  /** false in tests / very old browsers: everything plays on plain elements */
  get supported(): boolean {
    return Boolean(AudioCtx);
  }

  /** Creates the context on first use (call from a user gesture when possible). */
  ensure(): Ctx | undefined {
    if (this.ctx || !AudioCtx) return this.ctx;
    try {
      const ctx = new AudioCtx({ latencyHint: 'playback' });
      this.master = ctx.createGain();
      this.music = ctx.createGain();
      this.voice = ctx.createGain();
      this.music.connect(this.master);
      this.voice.connect(this.master);
      this.master.connect(ctx.destination);
      this.ctx = ctx;
      this.onCreate?.();
    } catch (err) {
      console.warn('[hostcaster] Web Audio unavailable, using plain audio', err);
    }
    return this.ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx && ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // needs a user gesture; the next play() tries again
      }
    }
  }

  /** Routes an element into `bus` through its own gain node (returned). An element can only be routed once. */
  route(el: HTMLMediaElement, bus: 'music' | 'voice'): GainNode | undefined {
    const ctx = this.ensure();
    const dest = bus === 'music' ? this.music : this.voice;
    if (!ctx || !dest) return undefined;
    if (this.sources.has(el)) throw new Error('element already routed');
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(dest);
    this.sources.set(el, src);
    return gain;
  }
}

/** Ramps an AudioParam linearly from `from` to `to` over `ms` (cancels earlier automation). */
export function rampParam(ctx: Ctx, param: AudioParam, from: number, to: number, ms: number): void {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  if (ms <= 0) {
    param.setValueAtTime(to, t);
    return;
  }
  param.setValueAtTime(from, t);
  param.linearRampToValueAtTime(to, t + ms / 1000);
}

/** blob:, data:, relative and same-origin URLs can go through Web Audio; anything else plays on a plain element. */
export function isRoutableUrl(url: string): boolean {
  if (/^(blob|data):/i.test(url)) return true;
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
