// Phone apps: YouTube plays only while Host-Caster is on screen. YouTube API Services policies do not allow playing
// from a player that is not displayed on the screen the user is viewing, so off screen the YouTube song pauses and
// the songs after it that may play (radio, files, servers) go first; back on screen it plays on. The web app keeps
// its own behaviour (no rule). The player's side is Player.setScreenOnly / setOnScreen; the visible mini window is
// in host.ts.
import { isDesktop } from '../../native/desktop';
import { isNative } from '../../native/platform';
import { onScreenChange } from '../../native/screen';
import type { Track } from '../../types';

interface ScreenAware {
  setScreenOnly(test: ((track: Track) => boolean) | undefined): void;
  setOnScreen(on: boolean): void;
}

/**
 * True in the phone apps and the desktop app: YouTube needs a visible player there (mini window, no background play;
 * on a computer, a minimized or hidden window is off screen).
 */
export const youTubeNeedsScreen: boolean = isNative || isDesktop;

export function bindYouTubeScreenRule(player: ScreenAware): () => void {
  if (!youTubeNeedsScreen) return () => {};
  player.setScreenOnly((t) => t.source === 'youtube');
  return onScreenChange((on) => player.setOnScreen(on));
}
