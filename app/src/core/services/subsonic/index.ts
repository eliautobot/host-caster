// Subsonic-compatible servers (Navidrome, Airsonic, Gonic, Ampache, Jellyfin via plugin ...).
export { md5 } from './md5';
export {
  authParams,
  encodePassword,
  makeSalt,
  normalizeServerUrl,
  passwordAuth,
  tokenAuth,
  tokenFor,
  SUBSONIC_API_VERSION,
  type SubsonicAuth,
} from './auth';
export { SubsonicClient, SubsonicError, SUBSONIC_ERR, arr } from './client';
export {
  connectSubsonic,
  disconnectSubsonic,
  getSubsonicClient,
  requireSubsonicClient,
  setSubsonicFetch,
  subsonicStatus,
  subsonicStreamUrl,
  type SubsonicConnectInput,
  type SubsonicStatus,
} from './store';
export {
  importSongs,
  importSubsonicAlbum,
  importSubsonicPlaylist,
  importSubsonicStarred,
  songToDraft,
  subsonicArtId,
} from './import';
export type * from './types';
