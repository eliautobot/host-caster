import { create } from 'zustand';
import { listPlaylists, listTracks } from '@/core/db';
import type { Playlist, Track } from '@/core/types';
import { bindLive } from './live';

interface LibraryStore {
  // TODO(library): page or virtualize when libraries get large.
  tracks: Track[];
  playlists: Playlist[];
  ready: boolean;
}

export const useLibrary = create<LibraryStore>(() => ({ tracks: [], playlists: [], ready: false }));

export const startLibraryStore = () => {
  const offTracks = bindLive(listTracks, (tracks) => useLibrary.setState({ tracks, ready: true }));
  const offLists = bindLive(listPlaylists, (playlists) => useLibrary.setState({ playlists }));
  return () => {
    offTracks();
    offLists();
  };
};
