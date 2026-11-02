// Music already on this device, added to the library as references to the files where they are (no copy, no upload).
// One scanner per platform: Android (MediaStore), the desktop app (music folders) and Chrome/Edge (a folder the
// browser keeps access to). Device songs never sync to other devices (TrackSource 'device', not in SYNCED_SOURCES).

export type DevicePlatform = 'android' | 'desktop' | 'web';

/** Access to the music: Android's audio permission, or the browser's permission for a stored folder. */
export type DeviceAccess = 'granted' | 'prompt' | 'denied' | 'blocked' | 'unsupported';

/** A song file the scan found. `ref` is the Track.ref ('android:<id>', 'desktop:<folder>/<path>', 'web:<folder>/<path>'). */
export interface DeviceSong {
  ref: string;
  /** folder the switches act on ('Music/Albums/Blue'); '' = the top of a music folder */
  folder: string;
  /** file name */
  name: string;
  /** path shown to people and used to match playlist files ('Music/Albums/Blue/01 Song.mp3') */
  path: string;
  size: number;
  mime: string;
  /** epoch ms; with `size`, tells a changed file from the same one */
  modifiedAt: number;
  /** 0 = unknown */
  durationMs: number;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  genre?: string;
  trackNo?: number;
  discNo?: number;
  /** Android: MediaStore album id (one cover per album) */
  albumKey?: string;
  /** what the system says the file is, when it knows (Android) */
  kind?: 'music' | 'ringtone' | 'notification' | 'alarm' | 'podcast' | 'audiobook' | 'recording';
  /** desktop/web: tags not read yet (read only for new or changed files) */
  needsTags?: boolean;
}

export interface DeviceFolder {
  key: string;
  /** songs in it (music only, after the filters) */
  count: number;
  included: boolean;
}

/** A root the person picked (desktop, web). */
export interface DeviceRoot {
  id: string;
  /** full path on the computer (desktop) or the folder's name (web) */
  label: string;
}

export interface DeviceMusicSettings {
  /** the person turned device music on (the first scan was added) */
  enabled: boolean;
  /** rescan when the app opens or comes back */
  autoUpdate: boolean;
  /** folder keys left out */
  excluded: string[];
  lastScanAt?: number;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceMusicSettings = { enabled: false, autoUpdate: true, excluded: [] };

export interface DeviceScanner {
  platform: DevicePlatform;
  access(): Promise<DeviceAccess>;
  /** asks for access (Android permission prompt); call from a tap */
  requestAccess(): Promise<DeviceAccess>;
  /** every audio file the system lists (filters run after) */
  scan(): Promise<DeviceSong[]>;
  /** fills in tags (desktop/web: read from the file) */
  readTags?(song: DeviceSong): Promise<DeviceSong & { picture?: { data: Uint8Array; mime: string } }>;
  /** cover art for a song (Android: one per album) */
  artwork?(song: DeviceSong): Promise<Blob | undefined>;
  /** playable URL for a Track.ref */
  url(ref: string): Promise<string>;
  /** desktop/web: the folders the person picked */
  roots?(): Promise<DeviceRoot[]>;
  /** a picker opens; desktop: `path` adds the suggested folder without one. undefined = cancelled */
  addRoot?(path?: string): Promise<DeviceRoot | undefined>;
  removeRoot?(id: string): Promise<void>;
  /** desktop: the system Music folder, suggested first */
  suggestedRoot?(): Promise<string | undefined>;
  /** Android: the app's page in the system settings (after "don't allow" twice) */
  openSettings?(): Promise<void>;
}
