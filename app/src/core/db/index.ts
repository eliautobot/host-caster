// core/db public surface. Import from '@/core/db'.
export { db, initDb } from './db';
export { HostCasterDB, DB_NAME } from './schema';
export { seedIfEmpty } from './seed';
export { stamp } from './stamp';
export { SEED_IDS, STARTER_HOSTS, STARTER_STATION, defaultProfile, defaultSettings, defaultSegments } from './defaults';
export { getProfile, saveProfile, getSettings, saveSettings } from './profile';
export { listHosts, getHost, saveHost, deleteHost, listStations, getStation, saveStation, deleteStation } from './hosts';
export {
  listTracks,
  countTracks,
  getTrack,
  saveTracks,
  deleteTrack,
  listPlaylists,
  getPlaylist,
  savePlaylist,
  deletePlaylist,
  putBlob,
  getBlob,
  deleteBlob,
} from './library';
export {
  listBrains,
  getBrain,
  saveBrain,
  deleteBrain,
  listVoices,
  getVoiceProvider,
  saveVoiceProvider,
  deleteVoiceProvider,
} from './brains';
export { addBreak, listBreaks } from './breaks';
export { kvGet, kvSet, kvDelete } from './kv';
