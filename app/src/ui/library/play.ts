// UI helpers that start playback from lists, with toasts.
import { create } from 'zustand';
import { player } from '@/core/player';
import type { Track } from '@/core/types';
import { runAction } from '../actions';
import { toast } from '../components';

/** What the queue was started from ("Album · First Signal"), shown as "Playing from" in Now Playing. */
export const usePlayContext = create<{ from?: string; to?: string }>(() => ({}));

const label = (tracks: Track[]) => (tracks.length === 1 ? `"${tracks[0]!.title}"` : `${tracks.length} songs`);

/** Plays `tracks` from `index` (shuffle: random order, starting anywhere). */
export function playTracks(tracks: Track[], index = 0, opts: { shuffle?: boolean; from?: string; to?: string } = {}) {
  if (!tracks.length) return;
  usePlayContext.setState({ from: opts.from, to: opts.to });
  return runAction(async () => {
    if (opts.shuffle !== undefined && opts.shuffle !== player.state.shuffle) player.setShuffle(opts.shuffle);
    const start = opts.shuffle ? Math.floor(Math.random() * tracks.length) : index;
    await player.playQueue(tracks, start);
  });
}

export function playNext(tracks: Track[]) {
  return runAction(async () => {
    await player.playNext(tracks);
    toast({ title: `${label(tracks)} will play next` });
  });
}

export function addToQueue(tracks: Track[]) {
  return runAction(async () => {
    await player.addToQueue(tracks);
    toast({ title: `Added ${label(tracks)} to the queue` });
  });
}

/** Is this list the one playing (same first track and length)? Used for the big Play/Pause buttons. */
export function isPlayingList(tracks: Track[], queue: Track[]): boolean {
  if (!tracks.length || !queue.length) return false;
  const ids = new Set(tracks.map((t) => t.id));
  return queue.length === tracks.length && queue.every((t) => ids.has(t.id));
}
