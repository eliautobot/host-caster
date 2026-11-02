// One fixed-position host for the YouTube iframe. The iframe is never moved in the DOM (moving reloads it);
// instead the host is laid over whatever "slot" element the UI provides (Now Playing art area).
// Web: with no slot on screen the host is parked in a corner, transparent and click-through.
// Phone and desktop apps (YouTube API Services policies: the player must be on the screen the user is viewing, at
// least 200x200, with YouTube's controls and links working): the host is always visible and tappable while a YouTube
// song is loaded, over the slot when Now Playing shows it, else in a window docked in a corner. The app keeps that
// corner's room free (dock.ts: a band above the mini player on a phone, a column beside the page on a computer), so
// the window never covers the app. Its bar drags it to another corner, toggles its size (also a double tap) and
// hides it: hidden, YouTube songs wait (videoWindow.ts, Player.setVideoHidden) until the "YouTube hidden" chip
// shows it again.
import { BAR_PX, DOCK_GAP_PX, VIDEO_MIN_PX, dockLayout, nearestCorner, type Corner, type DockEdges, type DockLayout } from './dock';
import { onVideoWindow, setVideoHidden, setVideoNeedsScreen, setVideoSize, videoWindow } from './videoWindow';

let host: HTMLDivElement | undefined;
let slot: HTMLElement | undefined;
let raf = 0;
let active = false;
let lastKey = '';

/** smallest player YouTube allows (CSS px) */
export const YT_MIN_PX = VIDEO_MIN_PX;
/** above everything the app shows (sheets, menus, toasts): the player is never covered */
const Z_MINI = 2_147_483_000;
const CORNER_KEY = 'hostcaster:yt-mini-corner';
/** two taps on the bar this close together toggle the size */
const DOUBLE_TAP_MS = 350;
/** the app's desktop layout (ui/hooks/useMediaQuery.ts) */
const DESKTOP_QUERY = '(min-width: 900px)';

const PARKED: Partial<CSSStyleDeclaration> = {
  left: 'auto',
  top: 'auto',
  right: '0px',
  bottom: '0px',
  width: '200px',
  height: '200px',
  opacity: '0',
  pointerEvents: 'none',
  zIndex: '-1',
  borderRadius: '0px',
};

const needsScreen = () => videoWindow().needsScreen;
const hidden = () => videoWindow().needsScreen && videoWindow().hidden;

/** The element YT.Player replaces with its iframe (inside the host). */
export function playerMount(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'aw-yt-host';
    if (!needsScreen()) host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', overflow: 'hidden', background: '#000', transition: 'opacity 200ms ease' }, PARKED);
    const mount = document.createElement('div');
    mount.id = 'aw-yt-player';
    host.appendChild(mount);
    document.body.appendChild(host);
    run();
  }
  return host.querySelector<HTMLElement>('#aw-yt-player') ?? host.firstElementChild as HTMLElement;
}

let scout: HTMLDivElement | undefined;

/** A second, always hidden player that checks upcoming videos (cue only, never plays). */
export function scoutMount(): HTMLElement {
  if (!scout) {
    scout = document.createElement('div');
    scout.className = 'aw-yt-scout';
    scout.setAttribute('aria-hidden', 'true');
    Object.assign(scout.style, { position: 'fixed', overflow: 'hidden' }, PARKED);
    const mount = document.createElement('div');
    scout.appendChild(mount);
    document.body.appendChild(scout);
    return mount;
  }
  return scout.firstElementChild as HTMLElement;
}

export function hostEl(): HTMLDivElement | undefined {
  return host;
}

/** Tests and debugging: the phone apps' rule (visible player, mini window) on or off. */
export function setYouTubeNeedsScreen(on: boolean): void {
  setVideoNeedsScreen(on);
}

if (typeof window !== 'undefined') {
  // tests: turn the phone apps' visible player on in a browser (window.__hostcaster.youtubeNeedsScreen(true))
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  (w.__hostcaster ??= {}).youtubeNeedsScreen = setYouTubeNeedsScreen;
  onVideoWindow((s) => {
    if (host) {
      if (s.needsScreen) host.removeAttribute('aria-hidden');
      else host.setAttribute('aria-hidden', 'true');
    }
    if (s.needsScreen && s.hidden) document.documentElement.dataset.ytHidden = '';
    else delete document.documentElement.dataset.ytHidden;
    if (mini) syncButtons(mini);
    lastKey = '';
    run();
  });
  if (hidden()) document.documentElement.dataset.ytHidden = '';
}

/** Shown in the slot (or the mini window) only while a YouTube track is loaded. */
export function setYouTubeActive(on: boolean): void {
  active = on;
  run();
}

/** Phone apps: what the mini window's open button does (the UI opens Now Playing). */
let openNowPlaying: (() => void) | undefined;
export function setYouTubeMiniOpen(fn: (() => void) | undefined): void {
  openNowPlaying = fn;
}

// ---------------------------------------------------------------------------------------------------- placement

/** Where the video goes now: the slot when it is on screen and not covered, else the mini window (phone apps). */
function target(): HTMLElement | undefined {
  if (!active) return undefined;
  // the listener hid the video: nowhere (its songs wait, see Player.setVideoHidden)
  if (hidden()) return undefined;
  if (slot && slot.isConnected) {
    const r = slot.getBoundingClientRect();
    // another sheet or menu on top of the slot: get out of its way (the player's own window does not count)
    const own = (el: Element) => Boolean(host?.contains(el) || mini?.box.contains(el));
    const hit = r.width > 0 ? document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((el) => !own(el)) : undefined;
    const visible = Boolean(hit && (hit === slot || slot.contains(hit)));
    if (visible && (!needsScreen() || (r.width >= YT_MIN_PX && r.height >= YT_MIN_PX))) return slot;
  }
  return needsScreen() ? miniVideo() : undefined;
}

function place() {
  if (!host) return;
  const el = target();
  if (el !== mini?.video) hideMini();
  else dockMini();
  if (!el) {
    if (lastKey !== 'parked') Object.assign(host.style, PARKED);
    lastKey = 'parked';
    return;
  }
  const r = el.getBoundingClientRect();
  const inMini = el === mini?.video;
  // web: a 16:9 video centred in the slot; phone apps: the whole slot (YouTube letterboxes), never under 200 px
  const w = r.width;
  const h = needsScreen() ? r.height : Math.min(r.height, (w * 9) / 16);
  const key = `${inMini ? 'm' : 's'}|${r.left}|${r.top}|${w}|${h}`;
  if (key === lastKey) return;
  lastKey = key;
  const radius = inMini ? (mini?.layout?.barBeside ? (mini.box.dataset.corner?.[1] === 'l' ? '13px 0 0 13px' : '0 13px 13px 0') : '0 0 13px 13px') : getComputedStyle(el).borderRadius || '16px';
  const zSheet = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--z-sheet'), 10) || 50;
  Object.assign(host.style, {
    left: `${r.left}px`,
    top: `${r.top + (r.height - h) / 2}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${w}px`,
    height: `${h}px`,
    opacity: '1',
    pointerEvents: needsScreen() ? 'auto' : 'none',
    zIndex: String(inMini ? Z_MINI + 1 : zSheet + 1),
    borderRadius: radius,
  } satisfies Partial<CSSStyleDeclaration>);
}

function loop() {
  place();
  raf = requestAnimationFrame(loop);
}

/** Follows the slot or the mini window every frame while either can show the video. */
function run() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (slot || (needsScreen() && active && host)) raf = requestAnimationFrame(loop);
  else place();
}

/** Lay the video over `el` while it is mounted (follows scroll, resize and sheet animations). */
export function attachYouTubeSlot(el: HTMLElement): () => void {
  slot = el;
  run();
  return () => {
    if (slot === el) {
      slot = undefined;
      run();
    }
  };
}

// ---------------------------------------------------------------------------------------------------- reserved room

let reserveKey = '';

/** The app keeps the docked window's room free: CSS variables the layout, sheets and toasts read (layout.css). */
function reserveRoom(corner: Corner | undefined, r?: DockLayout['reserve']) {
  const key = corner && r ? `${corner}|${r.top}|${r.bottom}|${r.left}|${r.right}` : '';
  if (key === reserveKey) return;
  reserveKey = key;
  const root = document.documentElement;
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    if (r && corner) root.style.setProperty(`--yt-res-${side}`, `${r[side]}px`);
    else root.style.removeProperty(`--yt-res-${side}`);
  }
  if (corner) root.dataset.ytDock = corner;
  else delete root.dataset.ytDock;
}

let probe: HTMLDivElement | undefined;

/** The device's safe areas (status bar, gesture bar, notch) in CSS px. */
function safeInsets() {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
      visibility: 'hidden',
      pointerEvents: 'none',
      padding: 'var(--safe-top, 0px) var(--safe-right, 0px) var(--safe-bottom, 0px) var(--safe-left, 0px)',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** the app's phone layout (pages without the app's frame, such as sign-in, follow the same width rule) */
function phoneLayout(): boolean {
  const layout = document.querySelector('.aw-app')?.getAttribute('data-layout');
  return layout ? layout !== 'desktop' : !window.matchMedia(DESKTOP_QUERY).matches;
}

const topOf = (sel: string) => {
  const r = document.querySelector(sel)?.getBoundingClientRect();
  return r && r.height > 0 ? r.top : undefined;
};

/** Where a docked window may go now: clear of the status bar, the mini player and tab bar, the sidebar, the player bar. */
function edges(): DockEdges {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const safe = safeInsets();
  // a full screen sheet (Now Playing) covers the app's bars: the window docks at the screen's edge instead
  const full = Boolean(document.querySelector('.aw-sheet-root[data-state="open"] .aw-sheet--full'));
  if (!phoneLayout()) {
    const side = document.querySelector('.aw-sidebar')?.getBoundingClientRect();
    const main = document.querySelector('.aw-main')?.getBoundingClientRect();
    const bar = topOf('.aw-playerbar');
    const g = DOCK_GAP_PX;
    return {
      layout: 'desktop',
      viewport,
      top: full || !main ? g : main.top,
      bottom: full || bar === undefined ? viewport.h - g : bar,
      left: full || !side ? g : side.right + g,
      right: viewport.w - g,
    };
  }
  // the mini player, and the on-air strip above it while a host talks
  const chrome = [topOf('.aw-mini-dock .aw-mini'), topOf('.aw-mini-dock .aw-onair--mini'), topOf('.aw-tabbar')].filter((v): v is number => v !== undefined);
  const bottom = full || !chrome.length ? viewport.h - safe.bottom : Math.min(...chrome);
  return { layout: 'phone', viewport, top: safe.top, bottom, left: safe.left, right: viewport.w - safe.right };
}

// ---------------------------------------------------------------------------------------------------- mini window

interface Mini {
  box: HTMLDivElement;
  bar: HTMLDivElement;
  video: HTMLDivElement;
  size: HTMLButtonElement;
  close: HTMLButtonElement;
  layout?: DockLayout;
}
let mini: Mini | undefined;
let corner: Corner | undefined;

const SVG = 'http://www.w3.org/2000/svg';
function icon(paths: string[], size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, String(v));
  }
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// lucide icons (the app's icon set)
const ICON_OPEN = ['M18 15l-6-6-6 6']; // chevron-up: opens Now Playing, as the mini player does
const ICON_SMALLER = ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7']; // minimize-2
const ICON_LARGER = ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']; // maximize-2
const ICON_CLOSE = ['M18 6 6 18', 'M6 6l12 12']; // x

function savedCorner(): Corner {
  try {
    const c = localStorage.getItem(CORNER_KEY);
    if (c === 'tl' || c === 'tr' || c === 'bl' || c === 'br') return c;
  } catch {
    // storage off
  }
  return 'br';
}

function miniVideo(): HTMLDivElement {
  if (!mini) mini = buildMini();
  const box = mini.box;
  if (box.style.display === 'none') {
    box.style.display = 'flex';
    corner ??= savedCorner();
  }
  return mini.video;
}

function hideMini() {
  if (mini && mini.box.style.display !== 'none') {
    mini.box.style.display = 'none';
    mini.layout = undefined;
  }
  reserveRoom(undefined);
}

/** Puts the window in its corner at its size and keeps that room free. */
function dockMini() {
  if (!mini) return;
  const c = corner ?? savedCorner();
  const d = dockLayout(c, videoWindow().size, edges());
  const prev = mini.layout;
  mini.layout = d;
  reserveRoom(c, d.reserve);
  const { box, bar, video } = mini;
  if (box.dataset.dragging) return; // it follows the finger; the room stays where it was until it is let go
  if (prev && prev.box.x === d.box.x && prev.box.y === d.box.y && prev.box.w === d.box.w && prev.box.h === d.box.h && box.dataset.corner === c) return;
  box.dataset.corner = c;
  box.dataset.size = d.barBeside ? 'small' : 'large';
  Object.assign(box.style, {
    left: `${d.box.x}px`,
    top: `${d.box.y}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${d.box.w}px`,
    height: `${d.box.h}px`,
    // small: the bar beside the video, on the side toward the middle of the screen
    flexDirection: d.barBeside ? (c[1] === 'l' ? 'row-reverse' : 'row') : 'column',
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(bar.style, {
    flexDirection: d.barBeside ? 'column' : 'row',
    width: d.barBeside ? `${BAR_PX}px` : 'auto',
    height: d.barBeside ? 'auto' : `${BAR_PX}px`,
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(video.style, { width: `${d.video.w}px`, height: `${d.video.h}px` });
}

function button(cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `aw-yt-mini__btn ${cls}`;
  // a tap on a button is not a drag
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', onClick);
  return b;
}

function setButton(b: HTMLButtonElement, label: string, paths: string[]) {
  if (b.getAttribute('aria-label') === label) return;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.replaceChildren(icon(paths, 18));
}

function syncButtons(m: Mini) {
  const small = videoWindow().size === 'small';
  setButton(m.size, small ? 'Larger video' : 'Smaller video', small ? ICON_LARGER : ICON_SMALLER);
  setButton(m.close, 'Hide video', ICON_CLOSE);
}

function toggleSize() {
  setVideoSize(videoWindow().size === 'small' ? 'large' : 'small');
}

function hideVideo() {
  const focused = mini?.box.contains(document.activeElement);
  setVideoHidden(true);
  // keyboard: focus goes to the "YouTube hidden" chip that brings the video back
  if (focused) requestAnimationFrame(() => document.querySelector<HTMLElement>('.aw-yt-chip')?.focus());
}

function buildMini(): Mini {
  const box = document.createElement('div');
  box.className = 'aw-yt-mini';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'YouTube video');
  Object.assign(box.style, {
    position: 'fixed',
    zIndex: String(Z_MINI),
    display: 'none',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const bar = document.createElement('div');
  bar.className = 'aw-yt-mini__bar';
  bar.title = 'Drag to another corner. Double tap to change the size.';
  Object.assign(bar.style, { display: 'flex', alignItems: 'center', flex: 'none', position: 'relative' } satisfies Partial<CSSStyleDeclaration>);

  const open = button('aw-yt-mini__open', () => openNowPlaying?.());
  setButton(open, 'Open Now Playing', ICON_OPEN);
  const grip = document.createElement('span');
  grip.className = 'aw-yt-mini__grip';
  grip.setAttribute('aria-hidden', 'true');
  const size = button('aw-yt-mini__size', toggleSize);
  const close = button('aw-yt-mini__close', hideVideo);
  // the bar's start is all drag handle (grab anywhere); the buttons sit together at its end
  bar.append(grip, open, size, close);

  const video = document.createElement('div');
  video.className = 'aw-yt-mini__video';
  Object.assign(video.style, { flex: 'none', background: '#000' });

  box.append(bar, video);
  document.body.appendChild(box);
  const m: Mini = { box, bar, video, size, close };
  syncButtons(m);
  dragBy(bar, box);
  return m;
}

/** Drag the window by its bar; on release it settles in the corner nearest the finger (remembered). Two quick taps: size. */
function dragBy(bar: HTMLElement, box: HTMLDivElement) {
  let start: { x: number; y: number; left: number; top: number; id: number; moved: boolean } | undefined;
  let lastTap = 0;
  bar.addEventListener('pointerdown', (e) => {
    const r = box.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId, moved: false };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
    start.moved = true;
    box.dataset.dragging = '1';
    const r = box.getBoundingClientRect();
    const left = Math.max(0, Math.min(window.innerWidth - r.width, start.left + e.clientX - start.x));
    const top = Math.max(0, Math.min(window.innerHeight - r.height, start.top + e.clientY - start.y));
    Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const moved = start.moved;
    start = undefined;
    delete box.dataset.dragging;
    if (!moved) {
      if (e.type === 'pointerup' && e.timeStamp - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        toggleSize();
      } else lastTap = e.timeStamp;
      return;
    }
    lastTap = 0;
    // the corner where the finger lets go (a large phone window is nearly as wide as the screen: its middle barely moves)
    const c = nearestCorner({ x: e.clientX, y: e.clientY, w: 0, h: 0 }, { w: window.innerWidth, h: window.innerHeight });
    try {
      localStorage.setItem(CORNER_KEY, c);
    } catch {
      // storage off: the corner holds until the app restarts
    }
    corner = c;
    if (mini) mini.layout = undefined;
    delete box.dataset.corner;
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}
