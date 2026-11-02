// The YouTube window's dock: never under 200x200, never over the page (the reserved room covers the window).
import { describe, expect, it } from 'vitest';
import { DOCK_GAP_PX, dockLayout, nearestCorner, overlaps, type Corner, type DockEdges, type Rect } from './dock';

const phone: DockEdges = { layout: 'phone', viewport: { w: 390, h: 844 }, top: 0, bottom: 844 - 58 - 6 - 60, left: 0, right: 390 };
const desktop: DockEdges = { layout: 'desktop', viewport: { w: 1440, h: 900 }, top: 8, bottom: 900 - 84, left: 8 + 256 + 8, right: 1440 - 8 };
const corners: Corner[] = ['tl', 'tr', 'bl', 'br'];

/** what the page keeps for itself: the viewport minus the reserved room */
function pageArea(e: DockEdges, r: { top: number; bottom: number; left: number; right: number }): Rect {
  const x = e.layout === 'desktop' ? e.left + r.left : 0;
  const right = e.layout === 'desktop' ? e.right - r.right : e.viewport.w;
  return { x, y: r.top, w: right - x, h: e.viewport.h - r.top - r.bottom };
}

describe('YouTube window dock', () => {
  it('small is exactly the 200x200 minimum; large is a bigger 16:9 picture, never under 200 px', () => {
    for (const e of [phone, desktop]) {
      expect(dockLayout('br', 'small', e).video).toEqual({ w: 200, h: 200 });
      const large = dockLayout('br', 'large', e).video;
      expect(large.w).toBeGreaterThan(300);
      expect(large.h).toBeGreaterThanOrEqual(200);
      expect(Math.abs(large.w / large.h - 16 / 9)).toBeLessThan(0.02);
    }
    // a narrow phone: still at least 200 px tall
    const narrow = dockLayout('br', 'large', { ...phone, viewport: { w: 320, h: 640 }, right: 320, bottom: 500 }).video;
    expect(narrow.h).toBeGreaterThanOrEqual(200);
    expect(narrow.w).toBeLessThanOrEqual(320 - 2 * DOCK_GAP_PX);
  });

  it('in every corner and size the window stays on screen and inside its reserved room, off the page', () => {
    for (const e of [phone, desktop]) {
      for (const c of corners) {
        for (const size of ['large', 'small'] as const) {
          const d = dockLayout(c, size, e);
          const b = d.box;
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(e.viewport.w);
          expect(b.y + b.h).toBeLessThanOrEqual(e.bottom);
          expect(overlaps(b, pageArea(e, d.reserve))).toBe(false);
          // the room follows the corner: one side only
          const sides = Object.entries(d.reserve).filter(([, v]) => v > 0).map(([k]) => k);
          expect(sides).toEqual([e.layout === 'phone' ? (c[0] === 't' ? 'top' : 'bottom') : c[1] === 'l' ? 'left' : 'right']);
        }
      }
    }
  });

  it('a phone keeps the band above the mini player; the page gets the rest', () => {
    const d = dockLayout('br', 'large', phone);
    expect(d.box.y + d.box.h).toBe(phone.bottom - DOCK_GAP_PX);
    expect(844 - d.reserve.bottom).toBe(d.box.y - DOCK_GAP_PX);
    expect(d.box.x + d.box.w).toBe(390 - DOCK_GAP_PX);
  });

  it('minimizing gives room back', () => {
    for (const e of [phone, desktop]) {
      for (const c of corners) {
        const big = dockLayout(c, 'large', e).reserve;
        const small = dockLayout(c, 'small', e).reserve;
        const sum = (r: typeof big) => r.top + r.bottom + r.left + r.right;
        expect(sum(small)).toBeLessThan(sum(big));
      }
    }
  });

  it('a computer keeps a column beside the page, as on the right of the sidebar', () => {
    const right = dockLayout('br', 'large', desktop);
    expect(right.box.x + right.box.w).toBe(desktop.right);
    expect(right.box.y + right.box.h).toBe(desktop.bottom);
    const left = dockLayout('tl', 'small', desktop);
    expect(left.box.x).toBe(desktop.left);
    expect(left.box.y).toBe(desktop.top);
    expect(left.reserve.left).toBe(left.box.w + DOCK_GAP_PX);
  });

  it('a dropped window settles in the nearest corner', () => {
    const vp = { w: 390, h: 844 };
    expect(nearestCorner({ x: 10, y: 100, w: 200, h: 200 }, vp)).toBe('tl');
    expect(nearestCorner({ x: 180, y: 100, w: 200, h: 200 }, vp)).toBe('tr');
    expect(nearestCorner({ x: 10, y: 600, w: 200, h: 200 }, vp)).toBe('bl');
    expect(nearestCorner({ x: 180, y: 600, w: 200, h: 200 }, vp)).toBe('br');
  });
});
