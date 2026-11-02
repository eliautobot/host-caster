// The music during a voice call: a quick fade and pause when the call starts, and back where it was when it ends.
// Host-Caster's own player (local files, streams, YouTube) pauses itself; in any-music-app mode (Android) the other
// app is paused through its media controls and Host-Caster holds the audio focus for the call, then gives it back
// and presses play again, but only when it was playing before.
import { anyApp, audioFocus } from '../native';
import { player } from '../player';
import type { Music } from './session';

const FADE_MS = 280;

export interface MusicTarget {
  /** the radio follows another music app (Android any-app mode) */
  anyApp: boolean;
}

/** A Music for one call. `hold` and `resume` each run once; resume only undoes what hold did. */
export function callMusic(target: () => MusicTarget): Music {
  let ownPaused = false;
  let otherPaused = false;
  let focus = false;
  return {
    async hold() {
      if (target().anyApp) {
        const now = await anyApp.nowPlaying().catch(() => undefined);
        if (now?.playing) otherPaused = await anyApp.control('pause').catch(() => false);
        // holding the focus pauses apps that ignore the media button, and keeps them quiet while the hosts talk
        focus = (await audioFocus.hold()) === 'granted';
        return;
      }
      const s = player.state.status;
      if (s !== 'playing' && s !== 'loading') return;
      ownPaused = true;
      player.duck(0, FADE_MS);
      await new Promise((r) => setTimeout(r, FADE_MS + 20));
      player.pause();
      // the volume is back for when it plays again (the fade-in on resume starts from silence)
      player.unduck(0);
    },
    async resume() {
      if (focus) await audioFocus.releaseHold();
      focus = false;
      if (otherPaused) await anyApp.control('play').catch(() => false);
      otherPaused = false;
      if (!ownPaused) return;
      ownPaused = false;
      if (player.state.status === 'playing') return;
      player.duck(0, 0);
      await player.play().catch(() => undefined);
      player.unduck(900);
    },
  };
}
