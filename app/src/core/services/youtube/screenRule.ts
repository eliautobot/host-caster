// Phone apps: YouTube plays only while Host-Caster is on screen. YouTube API Services policies do not allow playing
// from a player that is not displayed on the screen the user is viewing, so off screen the YouTube song pauses and
// the songs after it that may play (radio, files, servers) go first; back on screen it plays on. The web app keeps
// its own behaviour (no rule). The player's side is Player.setScreenOnly / setOnScreen; the visible mini window is
// in host.ts. A video the listener hides with the window's close button takes the same path
// (Player.setVideoHidden, videoWindow.ts): YouTube songs wait until it shows again.
import { onScreenChange } from '../../native/screen';
import type { Track } from '../../types';
import { onVideoWindow, videoHidden, videoWindow, youTubeNeedsScreen, type VideoWindowState } from './videoWindow';

export { youTubeNeedsScreen } from './videoWindow';

interface ScreenAware {
  setScreenOnly(test: ((track: Track) => boolean) | undefined): void;
  setOnScreen(on: boolean): void;
  setVideoHidden(hidden: boolean): void;
}

const isYouTube = (t: Track) => t.source === 'youtube';

export function bindYouTubeScreenRule(player: ScreenAware): () => void {
  let ruleOn: boolean | undefined;
  const apply = (s: VideoWindowState) => {
    if (s.needsScreen !== ruleOn) {
      ruleOn = s.needsScreen;
      // web: no rule unless a test turns it on (window.__hostcaster.youtubeNeedsScreen(true))
      player.setScreenOnly(ruleOn ? isYouTube : undefined);
    }
    player.setVideoHidden(videoHidden(s));
  };
  apply(videoWindow());
  const offWindow = onVideoWindow(apply);
  const offScreen = youTubeNeedsScreen ? onScreenChange((on) => player.setOnScreen(on)) : () => {};
  return () => {
    offWindow();
    offScreen();
  };
}
