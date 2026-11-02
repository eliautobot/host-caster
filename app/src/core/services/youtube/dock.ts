// Where the YouTube window docks and how much room the app keeps free for it (phone and desktop apps). The window
// never covers the app: on a phone it sits in a band above the mini player (bottom corners) or below the status bar
// (top corners) and the page ends at that band; on a computer it sits in a column beside the page, right or left of
// it. Pure geometry: host.ts measures the edges and applies the result.
import type { VideoSize } from './videoWindow';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** smallest player YouTube allows (CSS px) */
export const VIDEO_MIN_PX = 200;
/** the window's bar (drag handle and its buttons): its height above the video, or its width beside a small one */
export const BAR_PX = 36;
/** the window's 1 px border on each side */
const BORDER_PX = 1;
/** room between the window and the app around it */
export const DOCK_GAP_PX = 8;
const PHONE_MAX_W = 480;
const DESKTOP_LARGE_W = 384;

export interface DockEdges {
  layout: 'phone' | 'desktop';
  viewport: { w: number; h: number };
  /** the window may start below this line (phone: the status bar; desktop: the top of the page panel) */
  top: number;
  /** ... end above this line (phone: the mini player or on-air strip; desktop: the player bar) */
  bottom: number;
  /** ... start right of this line (phone: the safe area; desktop: the sidebar) */
  left: number;
  /** ... end left of this line (phone: the safe area; desktop: the window's edge) */
  right: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DockLayout {
  /** the whole window: border, bar and video */
  box: Rect;
  /** the video (where the player goes), CSS px, never under 200x200 */
  video: { w: number; h: number };
  /** the bar sits beside the video (small size) instead of above it */
  barBeside: boolean;
  /** room the app keeps free, measured from each edge of the viewport (0 = none on that side) */
  reserve: { top: number; bottom: number; left: number; right: number };
}

/** The video's size: small is exactly the 200x200 minimum; large is 16:9 (never under 200 px tall). */
export function videoSize(size: VideoSize, edges: DockEdges): { w: number; h: number } {
  if (size === 'small') return { w: VIDEO_MIN_PX, h: VIDEO_MIN_PX };
  const room = edges.right - edges.left - 2 * DOCK_GAP_PX - 2 * BORDER_PX;
  const w = edges.layout === 'phone' ? Math.min(PHONE_MAX_W, room) : Math.min(DESKTOP_LARGE_W, room);
  const width = Math.max(VIDEO_MIN_PX, Math.floor(w));
  return { w: width, h: Math.max(VIDEO_MIN_PX, Math.round((width * 9) / 16)) };
}

export function dockLayout(corner: Corner, size: VideoSize, edges: DockEdges): DockLayout {
  const video = videoSize(size, edges);
  const barBeside = size === 'small';
  const w = video.w + (barBeside ? BAR_PX : 0) + 2 * BORDER_PX;
  const h = video.h + (barBeside ? 0 : BAR_PX) + 2 * BORDER_PX;
  const top = corner[0] === 't';
  const left = corner[1] === 'l';
  const g = DOCK_GAP_PX;
  const reserve = { top: 0, bottom: 0, left: 0, right: 0 };
  let x: number;
  let y: number;
  if (edges.layout === 'phone') {
    // a band across the screen: the page ends above it (bottom) or starts below it (top)
    x = left ? edges.left + g : edges.right - g - w;
    y = top ? edges.top + g : edges.bottom - g - h;
    if (top) reserve.top = Math.ceil(y + h + g);
    else reserve.bottom = Math.ceil(edges.viewport.h - (y - g));
  } else {
    // a column beside the page panel, as tall as the page: the window sits at its top or bottom
    x = left ? edges.left : edges.right - w;
    y = top ? edges.top : edges.bottom - h;
    if (left) reserve.left = Math.ceil(w + g);
    else reserve.right = Math.ceil(w + g);
  }
  return { box: { x: Math.round(x), y: Math.round(y), w, h }, video, barBeside, reserve };
}

/** The corner nearest to a point or rectangle (where a dragged window was let go). */
export function nearestCorner(r: Rect, viewport: { w: number; h: number }): Corner {
  return `${r.y + r.h / 2 < viewport.h / 2 ? 't' : 'b'}${r.x + r.w / 2 < viewport.w / 2 ? 'l' : 'r'}`;
}

/** True when two rectangles share any area (touching edges do not count). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
