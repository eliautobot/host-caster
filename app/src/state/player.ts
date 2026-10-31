import { create } from 'zustand';
import { player } from '@/core/player';
import { serviceAdapters } from '@/core/services/adapters';
import { bindYouTubeScreenRule } from '@/core/services/youtube/screenRule';
import type { PlayerState } from '@/core/types';

/** Mirrors core player.state for React. Call player.* directly for actions. */
export const usePlayer = create<PlayerState>(() => player.state);

export const startPlayerStore = () => {
  for (const a of serviceAdapters()) player.registerAdapter(a);
  // phone apps: YouTube plays only while the app is on screen
  const offScreenRule = bindYouTubeScreenRule(player);
  const offState = player.on('state', (s) => usePlayer.setState(s, true));
  const off = () => {
    offScreenRule();
    offState();
  };
  // the saved queue and position, paused (play resumes where you left off)
  void player.restore().catch((err: unknown) => console.warn('[hostcaster] could not restore the player', err));
  return off;
};
