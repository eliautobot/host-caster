// Dexie schema. Add a new version() block for every schema change; never edit a shipped one.
import Dexie, { type Table } from 'dexie';
import type {
  BlobRecord,
  Brain,
  Break,
  Host,
  JournalEntry,
  KvRecord,
  MemoryCard,
  TrackedItem,
  Playlist,
  Profile,
  Settings,
  Station,
  Track,
  VoiceProvider,
} from '../types';

export const DB_NAME = 'hostcaster';

export class HostCasterDB extends Dexie {
  tracks!: Table<Track, string>;
  blobs!: Table<BlobRecord, string>;
  playlists!: Table<Playlist, string>;
  hosts!: Table<Host, string>;
  stations!: Table<Station, string>;
  brains!: Table<Brain, string>;
  voices!: Table<VoiceProvider, string>;
  breaks!: Table<Break, string>;
  profile!: Table<Profile, string>;
  settings!: Table<Settings, string>;
  kv!: Table<KvRecord, string>;
  memories!: Table<MemoryCard, string>;
  tracker!: Table<TrackedItem, string>;
  journal!: Table<JournalEntry, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      // booleans are not valid IndexedDB keys, so `liked` is filtered, not indexed
      tracks: 'id, title, artist, album, source, addedAt, lastPlayedAt, [source+ref]',
      blobs: 'id',
      playlists: 'id, name, source, updatedAt',
      hosts: 'id, name, createdAt',
      stations: 'id, name, createdAt',
      brains: 'id, kind',
      voices: 'id, kind',
      breaks: 'id, stationId, at, [stationId+at]',
      profile: 'id',
      settings: 'id',
      kv: 'id, fetchedAt',
    });
    // memory (core/memory): the cards the hosts remember (synced) and the 14-day journal (this device only)
    this.version(2).stores({
      memories: 'id, kind, updatedAt',
      journal: 'id, day, at, kind',
    });
    // Your list (core/tracker): tasks, events, bills and invitations the hosts keep track of (synced)
    this.version(3).stores({
      tracker: 'id, status, kind, key, updatedAt',
    });
  }
}
