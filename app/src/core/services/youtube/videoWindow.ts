// The YouTube window's choices in the phone and desktop apps (where a YouTube song plays only from a player on
// screen): hidden with its close button, and its size. Hidden YouTube songs wait (the player's off screen path,
// Player.setVideoHidden) until the listener shows the video again. Hidden lasts for this session only: after a
// restart the video shows again, so YouTube never stays silently off because of a tap made days ago. The size is a
// preference and is kept.
import { isDesktop } from '../../native/desktop';
import { isNative } from '../../native/platform';

/** large: a 16:9 picture; small: exactly the 200x200 minimum YouTube allows */
export type VideoSize = 'large' | 'small';

export interface VideoWindowState {
  /** the visible player rule is on (phone and desktop apps; tests can turn it on in a browser) */
  needsScreen: boolean;
  /** the listener closed the window */
  hidden: boolean;
  size: VideoSize;
}

/**
 * True in the phone apps and the desktop app: YouTube needs a visible player there (mini window, no background play;
 * on a computer, a minimized or hidden window is off screen).
 */
export const youTubeNeedsScreen: boolean = isNative || isDesktop;

const HIDDEN_KEY = 'hostcaster:yt-hidden';
const SIZE_KEY = 'hostcaster:yt-size';

function read(store: 'session' | 'local', key: string): string | null {
  try {
    return (store === 'session' ? sessionStorage : localStorage).getItem(key);
  } catch {
    return null; // storage off (or tests without a DOM)
  }
}

function write(store: 'session' | 'local', key: string, value: string | null) {
  try {
    const s = store === 'session' ? sessionStorage : localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // storage off: the choice holds until the app restarts
  }
}

let state: VideoWindowState = {
  needsScreen: youTubeNeedsScreen,
  hidden: read('session', HIDDEN_KEY) === '1',
  size: read('local', SIZE_KEY) === 'small' ? 'small' : 'large',
};
const listeners = new Set<(s: VideoWindowState) => void>();

export function videoWindow(): VideoWindowState {
  return state;
}

/** True while the listener's close button keeps YouTube songs waiting (only where the visible player rule is on). */
export function videoHidden(s: VideoWindowState = state): boolean {
  return s.needsScreen && s.hidden;
}

export function onVideoWindow(cb: (s: VideoWindowState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function update(patch: Partial<VideoWindowState>) {
  const next = { ...state, ...patch };
  if (next.needsScreen === state.needsScreen && next.hidden === state.hidden && next.size === state.size) return;
  state = next;
  for (const cb of [...listeners]) cb(state);
}

/** The close button (true) and the "YouTube hidden" chip (false). */
export function setVideoHidden(hidden: boolean): void {
  write('session', HIDDEN_KEY, hidden ? '1' : null);
  update({ hidden });
}

export function setVideoSize(size: VideoSize): void {
  write('local', SIZE_KEY, size === 'small' ? 'small' : null);
  update({ size });
}

/** Tests and debugging: the phone apps' rule (visible player, mini window) on or off in a browser. */
export function setVideoNeedsScreen(on: boolean): void {
  update({ needsScreen: on });
}
