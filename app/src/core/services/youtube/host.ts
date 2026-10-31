// One fixed-position host for the YouTube iframe. The iframe is never moved in the DOM (moving reloads it);
// instead the host is laid over whatever "slot" element the UI provides (Now Playing art area).
// Web: with no slot on screen the host is parked in a corner, transparent and click-through.
// Phone apps (YouTube API Services policies: the player must be on the screen the user is viewing, at least 200x200,
// with YouTube's controls and links working): the host is always visible and tappable while a YouTube song is loaded,
// over the slot when Now Playing shows it, else in a small floating window the user can drag to any corner.
import { youTubeNeedsScreen } from './screenRule';

let host: HTMLDivElement | undefined;
let slot: HTMLElement | undefined;
let raf = 0;
let active = false;
let lastKey = '';
let needsScreen = youTubeNeedsScreen;

/** smallest player YouTube allows (CSS px), with a little room for rounding */
export const YT_MIN_PX = 200;
const MINI_PX = 208;
const BAR_PX = 28;
const EDGE_PX = 12;
/** above everything the app shows (sheets, menus, toasts): the player is never covered */
const Z_MINI = 2_147_483_000;
const CORNER_KEY = 'hostcaster:yt-mini-corner';

type Corner = 'tl' | 'tr' | 'bl' | 'br';

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

/** The element YT.Player replaces with its iframe (inside the host). */
export function playerMount(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'aw-yt-host';
    if (!needsScreen) host.setAttribute('aria-hidden', 'true');
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
  needsScreen = on;
  if (host) {
    if (on) host.removeAttribute('aria-hidden');
    else host.setAttribute('aria-hidden', 'true');
  }
  run();
}

if (typeof window !== 'undefined') {
  // tests: turn the phone apps' visible player on in a browser (window.__hostcaster.youtubeNeedsScreen(true))
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  (w.__hostcaster ??= {}).youtubeNeedsScreen = setYouTubeNeedsScreen;
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
  if (slot && slot.isConnected) {
    const r = slot.getBoundingClientRect();
    // another sheet or menu on top of the slot: get out of its way (the player's own window does not count)
    const own = (el: Element) => Boolean(host?.contains(el) || mini?.box.contains(el));
    const hit = r.width > 0 ? document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((el) => !own(el)) : undefined;
    const visible = Boolean(hit && (hit === slot || slot.contains(hit)));
    if (visible && (!needsScreen || (r.width >= YT_MIN_PX && r.height >= YT_MIN_PX))) return slot;
  }
  return needsScreen ? miniVideo() : undefined;
}

function place() {
  if (!host) return;
  const el = target();
  if (el !== mini?.video) hideMini();
  if (!el) {
    if (lastKey !== 'parked') Object.assign(host.style, PARKED);
    lastKey = 'parked';
    return;
  }
  const r = el.getBoundingClientRect();
  const inMini = el === mini?.video;
  // web: a 16:9 video centred in the slot; phone apps: the whole slot (YouTube letterboxes), never under 200 px
  const w = r.width;
  const h = needsScreen ? r.height : Math.min(r.height, (w * 9) / 16);
  const key = `${inMini ? 'm' : 's'}|${r.left}|${r.top}|${w}|${h}`;
  if (key === lastKey) return;
  lastKey = key;
  const radius = inMini ? '0 0 13px 13px' : getComputedStyle(el).borderRadius || '16px';
  const zSheet = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--z-sheet'), 10) || 50;
  Object.assign(host.style, {
    left: `${r.left}px`,
    top: `${r.top + (r.height - h) / 2}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${w}px`,
    height: `${h}px`,
    opacity: '1',
    pointerEvents: needsScreen ? 'auto' : 'none',
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
  if (slot || (needsScreen && active && host)) raf = requestAnimationFrame(loop);
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

// ---------------------------------------------------------------------------------------------------- mini window

interface Mini {
  box: HTMLDivElement;
  video: HTMLDivElement;
}
let mini: Mini | undefined;

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

function savedCorner(): Corner {
  try {
    const c = localStorage.getItem(CORNER_KEY);
    if (c === 'tl' || c === 'tr' || c === 'bl' || c === 'br') return c;
  } catch {
    // storage off
  }
  return 'br';
}

function phoneLayout(): boolean {
  return document.querySelector('.aw-app')?.getAttribute('data-layout') !== 'desktop';
}

/** The corner's insets: clear of the status bar and header on top, of the mini player and tab bar below. */
function cornerInsets(c: Corner): Partial<CSSStyleDeclaration> {
  const below = phoneLayout() ? `calc(var(--safe-bottom, 0px) + var(--tabbar-h, 58px) + var(--miniplayer-h, 60px) + ${EDGE_PX}px)` : `calc(var(--playerbar-h, 84px) + ${EDGE_PX}px)`;
  const above = `calc(var(--safe-top, 0px) + 64px)`;
  return {
    left: c[1] === 'l' ? `calc(var(--safe-left, 0px) + ${EDGE_PX}px)` : 'auto',
    right: c[1] === 'r' ? `calc(var(--safe-right, 0px) + ${EDGE_PX}px)` : 'auto',
    top: c[0] === 't' ? above : 'auto',
    bottom: c[0] === 'b' ? below : 'auto',
  };
}

function setCorner(box: HTMLDivElement, c: Corner) {
  box.dataset.corner = c;
  Object.assign(box.style, cornerInsets(c));
}

function miniVideo(): HTMLDivElement {
  if (!mini) mini = buildMini();
  const box = mini.box;
  if (box.style.display === 'none') {
    box.style.display = 'flex';
    if (!box.dataset.dragging) setCorner(box, savedCorner());
  }
  return mini.video;
}

function hideMini() {
  if (mini && mini.box.style.display !== 'none') mini.box.style.display = 'none';
}

function buildMini(): Mini {
  const box = document.createElement('div');
  box.className = 'aw-yt-mini';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'YouTube player');
  Object.assign(box.style, {
    position: 'fixed',
    zIndex: String(Z_MINI),
    width: `${MINI_PX + 2}px`, // + the 1 px border on each side
    display: 'none',
    flexDirection: 'column',
    borderRadius: '14px',
    overflow: 'hidden',
    background: 'var(--surface-2, #1b1b1e)',
    border: '1px solid var(--line, #2a2a2e)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const bar = document.createElement('div');
  bar.className = 'aw-yt-mini__bar';
  Object.assign(bar.style, {
    height: `${BAR_PX}px`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    color: 'var(--text-2, #a1a1aa)',
    cursor: 'grab',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const grip = icon(['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'], 16);
  grip.style.transform = 'rotate(90deg)';
  bar.appendChild(grip);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'aw-yt-mini__open';
  open.setAttribute('aria-label', 'Open Now Playing');
  Object.assign(open.style, {
    position: 'absolute',
    right: '2px',
    top: '0px',
    width: `${BAR_PX + 8}px`,
    height: `${BAR_PX}px`,
    display: 'grid',
    placeItems: 'center',
    border: '0',
    padding: '0',
    background: 'transparent',
    color: 'var(--text-2, #a1a1aa)',
  } satisfies Partial<CSSStyleDeclaration>);
  open.appendChild(icon(['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'], 15));
  open.addEventListener('pointerdown', (e) => e.stopPropagation());
  open.addEventListener('click', () => openNowPlaying?.());
  bar.appendChild(open);

  const video = document.createElement('div');
  video.className = 'aw-yt-mini__video';
  Object.assign(video.style, { width: `${MINI_PX}px`, height: `${MINI_PX}px`, background: '#000' });

  box.append(bar, video);
  document.body.appendChild(box);
  dragBy(bar, box);
  return { box, video };
}

/** Drag the window by its bar; on release it settles in the nearest corner (remembered). */
function dragBy(bar: HTMLElement, box: HTMLDivElement) {
  let start: { x: number; y: number; left: number; top: number; id: number } | undefined;
  bar.addEventListener('pointerdown', (e) => {
    const r = box.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
    bar.setPointerCapture(e.pointerId);
    box.dataset.dragging = '1';
    bar.style.cursor = 'grabbing';
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, right: 'auto', bottom: 'auto' });
  });
  bar.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const r = box.getBoundingClientRect();
    const left = Math.max(0, Math.min(window.innerWidth - r.width, start.left + e.clientX - start.x));
    const top = Math.max(0, Math.min(window.innerHeight - r.height, start.top + e.clientY - start.y));
    Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    start = undefined;
    delete box.dataset.dragging;
    bar.style.cursor = 'grab';
    const r = box.getBoundingClientRect();
    const c: Corner = `${r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b'}${r.left + r.width / 2 < window.innerWidth / 2 ? 'l' : 'r'}`;
    try {
      localStorage.setItem(CORNER_KEY, c);
    } catch {
      // storage off: the corner holds until the app restarts
    }
    setCorner(box, c);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}
