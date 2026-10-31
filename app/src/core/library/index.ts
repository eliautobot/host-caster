// core/library (owner: player agent): importing songs, playlists, M3U/PLS, internet streams, the server library.
export { importer, type ImportProgress } from './importer';
export {
  AUDIO_ACCEPT,
  PLAYLIST_ACCEPT,
  fromDataTransfer,
  fromFileList,
  isAudioFile,
  sortPicked,
  supportsFolderPick,
  type PickedFile,
} from './files';
export { DuplicateIndex, fingerprint, songKey } from './dedupe';
export { readSongMeta, type SongMeta } from './metadata';
export {
  exportM3U,
  matchEntries,
  parseM3U,
  parsePLS,
  parsePlaylistFile,
  playlistFileName,
  type EntryMatch,
  type ParsedPlaylist,
  type PlaylistEntry,
} from './m3u';
export {
  addToPlaylist,
  createPlaylist,
  importPlaylistText,
  playlistToM3U,
  playlistTracks,
  removeFromPlaylist,
  removePlaylist,
  reorderPlaylist,
  updatePlaylist,
  type PlaylistImportResult,
} from './playlists';
export { addStream, addStreams, normalizeStreamUrl } from './streams';
export { deleteTracks, setLiked, storageUsage, toggleLike, type StorageUsage } from './tracks';
export {
  rescanServerLibrary,
  serverLibraryAvailable,
  serverTrackToTrack,
  syncServerLibrary,
  syncServerLibraryIfStale,
  type ServerSyncResult,
} from './server';
export {
  VARIOUS_ARTISTS,
  albumIdOf,
  artistIdOf,
  byAlbumOrder,
  groupAlbums,
  groupArtists,
  matchesName,
  searchTracks,
  sortTracks,
  type Album,
  type Artist,
  type TrackSort,
} from './group';
export { formatBytes, formatTotal, plural, titleFromFileName } from './text';
