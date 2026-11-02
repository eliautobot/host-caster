// The Slider's gestures, apart from React so they can be tested. Every value the user picks ends in exactly one commit
// (seek, save), whatever the engine sends:
// - touch and pen: the slider follows the finger itself (pointer events + capture). A tap jumps there, a sideways drag
//   scrubs, an up/down swipe is left to the page (touch-action: pan-y). Some Android WebViews move a range input only
//   on a late synthetic click after pointerup, or never drag it; owning the gesture makes every engine behave the same.
// - mouse and keyboard: the native range input, committed on its `change` event, on pointerup, or when idle.
// - failsafe: a picked value never waits forever (lost pointerup, pointercancel, an input event nobody ends).

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

export interface GestureOptions extends SliderRange {
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
  /** the range's box on screen (touch values come from the finger's x) */
  rect: () => { left: number; width: number };
  /** shows the thumb while a finger is on the slider */
  onActive?: (active: boolean) => void;
}

export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** thumb width in px: its centre runs from thumb/2 to width - thumb/2, like the native range */
export const THUMB = 14;
/** movement before a touch counts as a drag (sideways) or a swipe (up/down) */
export const SLOP = 8;
/** after a mouse/keyboard input with no button held: commit when nothing else arrives */
export const IDLE_MS = 600;
/** after a mouse pointerup: wait for the native change event (some engines send the last input late) */
export const END_MS = 150;
/** a button or finger held still this long: commit anyway (its up may never come) */
export const HOLD_MS = 5000;
/** after a touch the slider handled itself: native events from that touch are echoes */
export const QUIET_MS = 500;

export function valueAt(clientX: number, rect: { left: number; width: number }, r: SliderRange, thumb = THUMB): number {
  const span = Math.max(1, rect.width - thumb);
  const f = Math.max(0, Math.min(1, (clientX - rect.left - thumb / 2) / span));
  return snap(r.min + f * (r.max - r.min), r);
}

export function snap(v: number, r: SliderRange): number {
  const stepped = r.step > 0 ? r.min + Math.round((v - r.min) / r.step) * r.step : v;
  return Math.max(r.min, Math.min(r.max, Number(stepped.toFixed(10))));
}

interface Down {
  id: number;
  /** touch/pen: the slider moves itself */
  owned: boolean;
  x0: number;
  y0: number;
  dragging: boolean;
}

export class SliderGesture {
  private pending: number | undefined;
  private down: Down | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private quietUntil = 0;

  constructor(
    private opts: () => GestureOptions,
    private now: () => number = () => Date.now(),
  ) {}

  /** a touch the slider handles itself is in progress or just ended: the native touch default is not wanted */
  get owning(): boolean {
    return Boolean(this.down?.owned) || this.now() < this.quietUntil;
  }

  /** a sideways touch drag is in progress (its touchmove must not scroll or move the native thumb) */
  get dragging(): boolean {
    return Boolean(this.down?.owned && this.down.dragging);
  }

  /** the native input event; returns false when it is an echo to ignore */
  input(v: number): boolean {
    if (this.down?.owned || this.now() < this.quietUntil) return false;
    this.pick(v);
    return true;
  }

  /** the native change event: the user let go (mouse) or stepped (keyboard) */
  change(v: number): void {
    if (this.down?.owned || this.now() < this.quietUntil) return;
    if (this.pending === undefined) this.pending = v;
    this.commit();
  }

  keyUp(): void {
    if (!this.down) this.commit();
  }

  blur(): void {
    if (!this.down?.owned) this.commit();
  }

  pointerDown(e: PointerLike): void {
    const o = this.opts();
    if (o.disabled) return;
    this.commit(); // a value left from a gesture whose end never came
    const owned = e.pointerType === 'touch' || e.pointerType === 'pen';
    this.down = { id: e.pointerId, owned, x0: e.clientX, y0: e.clientY, dragging: false };
    if (owned) o.onActive?.(true);
    this.arm(HOLD_MS);
  }

  pointerMove(e: PointerLike): void {
    const d = this.down;
    if (!d?.owned || d.id !== e.pointerId) return;
    if (!d.dragging) {
      const dx = Math.abs(e.clientX - d.x0);
      const dy = Math.abs(e.clientY - d.y0);
      if (dx < SLOP || dx < dy) return; // not sideways yet: maybe a tap, maybe the page scrolls
      d.dragging = true;
    }
    this.pick(this.at(e.clientX), HOLD_MS);
  }

  pointerUp(e: PointerLike): void {
    const d = this.down;
    if (!d || d.id !== e.pointerId) return;
    this.down = undefined;
    if (!d.owned) {
      // mouse: the native change event commits; this is the fallback
      if (this.pending !== undefined) this.arm(END_MS);
      return;
    }
    this.endOwned();
    const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    if (d.dragging || moved < SLOP * 2) this.pending = this.at(d.dragging ? e.clientX : d.x0);
    if (this.pending !== undefined) this.opts().onChange(this.pending);
    this.commit();
  }

  /** pointercancel / lostpointercapture: the browser or the system took the pointer */
  pointerCancel(e: { pointerId: number }): void {
    const d = this.down;
    if (!d || d.id !== e.pointerId) return;
    this.down = undefined;
    if (d.owned) {
      this.endOwned();
      if (!d.dragging) this.pending = undefined; // the page scrolled: nothing was picked
    }
    this.commit();
  }

  /** unmount: a picked value still counts */
  dispose(): void {
    this.down = undefined;
    this.commit();
  }

  private at(clientX: number): number {
    const o = this.opts();
    return valueAt(clientX, o.rect(), o);
  }

  private pick(v: number, wait = this.down ? HOLD_MS : IDLE_MS) {
    this.pending = v;
    this.opts().onChange(v);
    this.arm(wait);
  }

  private endOwned() {
    this.quietUntil = this.now() + QUIET_MS;
    this.opts().onActive?.(false);
  }

  private arm(ms: number) {
    clearTimeout(this.timer);
    // the pointer stays down: a finger held still keeps scrubbing when it moves again
    this.timer = setTimeout(() => this.commit(), ms);
  }

  private commit() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const v = this.pending;
    this.pending = undefined;
    if (v !== undefined) this.opts().onCommit?.(v);
  }
}
