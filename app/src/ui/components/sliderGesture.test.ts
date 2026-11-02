import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { END_MS, HOLD_MS, IDLE_MS, QUIET_MS, SliderGesture, snap, THUMB, valueAt, type GestureOptions } from './sliderGesture';

// a 0..100 s seek bar, 1 s steps, 214 px wide at x = 100 (the thumb's centre runs 107..307)
const RECT = { left: 100, width: 214 };
const xFor = (ms: number) => RECT.left + THUMB / 2 + ((RECT.width - THUMB) * ms) / 100_000;

function setup(extra: Partial<GestureOptions> = {}) {
  const changes: number[] = [];
  const commits: number[] = [];
  const active: boolean[] = [];
  let clock = 0;
  const opts: GestureOptions = {
    min: 0,
    max: 100_000,
    step: 1000,
    rect: () => RECT,
    onChange: (v) => changes.push(v),
    onCommit: (v) => commits.push(v),
    onActive: (a) => active.push(a),
    ...extra,
  };
  const g = new SliderGesture(() => opts, () => clock);
  const tick = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  const touch = (clientX: number, clientY = 50, pointerId = 1) => ({ pointerId, pointerType: 'touch', clientX, clientY });
  const mouse = (clientX: number) => ({ pointerId: 9, pointerType: 'mouse', clientX, clientY: 50 });
  return { g, changes, commits, active, tick, touch, mouse };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('valueAt', () => {
  it('maps the thumb centre range to min..max and snaps to the step', () => {
    const r = { min: 0, max: 100_000, step: 1000 };
    expect(valueAt(xFor(0), RECT, r)).toBe(0);
    expect(valueAt(xFor(50_000), RECT, r)).toBe(50_000);
    expect(valueAt(xFor(100_000), RECT, r)).toBe(100_000);
    expect(valueAt(0, RECT, r)).toBe(0);
    expect(valueAt(9999, RECT, r)).toBe(100_000);
  });

  it('keeps decimal steps clean', () => {
    expect(snap(0.30000000000000004, { min: 0, max: 1, step: 0.01 })).toBe(0.3);
    expect(snap(0.71, { min: 0.7, max: 1.4, step: 0.02 })).toBe(0.72);
  });
});

describe('touch: the slider follows the finger', () => {
  it('a tap jumps there and commits once', () => {
    const { g, changes, commits, touch } = setup();
    g.pointerDown(touch(xFor(40_000)));
    expect(changes).toEqual([]);
    g.pointerUp(touch(xFor(40_000) + 3));
    expect(changes).toEqual([40_000]);
    expect(commits).toEqual([40_000]);
  });

  it('a sideways drag scrubs live and commits where the finger lets go', () => {
    const { g, changes, commits, active, touch } = setup();
    g.pointerDown(touch(xFor(20_000)));
    g.pointerMove(touch(xFor(20_000) + 4)); // under the slop: maybe still a tap
    expect(changes).toEqual([]);
    g.pointerMove(touch(xFor(50_000)));
    g.pointerMove(touch(xFor(80_000)));
    expect(changes).toEqual([50_000, 80_000]);
    expect(commits).toEqual([]);
    g.pointerUp(touch(xFor(81_000)));
    expect(commits).toEqual([81_000]);
    expect(active).toEqual([true, false]);
  });

  it('pointercancel mid-drag still commits the last value (no stuck scrub)', () => {
    const { g, commits, active, touch } = setup();
    g.pointerDown(touch(xFor(10_000)));
    g.pointerMove(touch(xFor(60_000)));
    g.pointerCancel({ pointerId: 1 });
    expect(commits).toEqual([60_000]);
    expect(active.at(-1)).toBe(false);
  });

  it('an up/down swipe the page scrolls with picks nothing', () => {
    const { g, changes, commits, touch } = setup();
    g.pointerDown(touch(xFor(30_000), 50));
    g.pointerMove(touch(xFor(30_000) + 3, 80)); // more up/down than sideways: not a drag
    g.pointerCancel({ pointerId: 1 }); // the browser took it for scrolling
    expect(changes).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('ignores the engine echo of its own touch (late input/change after pointerup)', () => {
    const { g, changes, commits, touch, tick } = setup();
    g.pointerDown(touch(xFor(70_000)));
    expect(g.input(12_000)).toBe(false); // native thumb moved under the finger: ignored while owned
    g.pointerUp(touch(xFor(70_000)));
    expect(g.owning).toBe(true); // touchend default (synthetic click) is prevented
    expect(g.input(69_000)).toBe(false);
    g.change(69_000);
    tick(IDLE_MS + 10);
    expect(changes).toEqual([70_000]);
    expect(commits).toEqual([70_000]);
    tick(QUIET_MS);
    expect(g.owning).toBe(false);
  });

  it('a finger held still keeps its pick (commits once) and scrubs again when it moves', () => {
    const { g, commits, touch, tick } = setup();
    g.pointerDown(touch(xFor(10_000)));
    g.pointerMove(touch(xFor(30_000)));
    tick(HOLD_MS + 10);
    expect(commits).toEqual([30_000]);
    g.pointerMove(touch(xFor(90_000)));
    g.pointerUp(touch(xFor(90_000)));
    expect(commits).toEqual([30_000, 90_000]);
  });

  it('a new touch after a lost up commits the old pick first', () => {
    const { g, commits, touch } = setup();
    g.pointerDown(touch(xFor(10_000)));
    g.pointerMove(touch(xFor(40_000)));
    g.pointerDown(touch(xFor(60_000), 50, 2));
    expect(commits).toEqual([40_000]);
    g.pointerUp(touch(xFor(60_000), 50, 2));
    expect(commits).toEqual([40_000, 60_000]);
  });

  it('does nothing when disabled', () => {
    const { g, changes, commits, touch } = setup({ disabled: true });
    g.pointerDown(touch(xFor(40_000)));
    g.pointerUp(touch(xFor(40_000)));
    expect(changes).toEqual([]);
    expect(commits).toEqual([]);
  });
});

describe('mouse and keyboard: the native range', () => {
  it('drag: input events preview, change commits once', () => {
    const { g, changes, commits, mouse, tick } = setup();
    g.pointerDown(mouse(xFor(20_000)));
    expect(g.input(20_000)).toBe(true);
    g.input(50_000);
    g.pointerUp(mouse(xFor(50_000)));
    g.change(50_000);
    tick(END_MS + 10);
    expect(changes).toEqual([20_000, 50_000]);
    expect(commits).toEqual([50_000]);
  });

  it('no change event (engine quirk): pointerup still commits', () => {
    const { g, commits, mouse, tick } = setup();
    g.pointerDown(mouse(0));
    g.input(30_000);
    g.pointerUp(mouse(0));
    expect(commits).toEqual([]);
    tick(END_MS + 10);
    expect(commits).toEqual([30_000]);
  });

  it('a value that arrives after pointerup (late synthetic click) commits when idle', () => {
    const { g, commits, mouse, tick } = setup();
    g.pointerDown(mouse(0));
    g.pointerUp(mouse(0)); // nothing picked yet
    g.input(75_000); // the engine moves the thumb now
    expect(commits).toEqual([]);
    tick(IDLE_MS + 10);
    expect(commits).toEqual([75_000]);
  });

  it('a lost pointerup cannot leave the value hanging', () => {
    const { g, commits, mouse, tick } = setup();
    g.pointerDown(mouse(0));
    g.input(40_000);
    tick(HOLD_MS + 10);
    expect(commits).toEqual([40_000]);
  });

  it('keys commit on change or keyup, once per value', () => {
    const { g, commits, tick } = setup();
    g.input(41_000);
    g.change(41_000);
    g.keyUp();
    g.input(42_000);
    g.keyUp();
    tick(IDLE_MS + 10);
    expect(commits).toEqual([41_000, 42_000]);
  });

  it('unmount commits a pending pick', () => {
    const { g, commits } = setup();
    g.input(33_000);
    g.dispose();
    expect(commits).toEqual([33_000]);
  });
});
