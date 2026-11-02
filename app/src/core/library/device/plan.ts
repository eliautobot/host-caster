// What a scan changes in the library (pure, tested): new songs to add, device songs whose file is gone or whose folder
// was switched off, files that changed (re-read their tags). Songs already in the library (an imported copy, the same
// song from a service, the same file in two folders) are not added twice. Nothing else in the library is touched.
import type { Track } from '../../types';
import { DuplicateIndex } from '../dedupe';
import { musicOnly } from './filters';
import type { DeviceFolder, DevicePlatform, DeviceSong } from './types';

export interface DevicePlan {
  /** new songs to add (in included folders, not already in the library) */
  add: DeviceSong[];
  /** device songs to take out: the file is gone, or its folder is switched off */
  remove: Track[];
  /** the same file changed (size or date): tags are read again, likes and plays stay */
  update: { track: Track; song: DeviceSong }[];
  /** found songs already in the library another way */
  duplicates: number;
  /** music found, per folder, with the switch state */
  folders: DeviceFolder[];
  /** music found in included folders (what the library will hold) */
  total: number;
}

export interface PlanOptions {
  platform: DevicePlatform;
  /** folder keys switched off */
  excluded: Iterable<string>;
  /**
   * The scan came back empty while the library holds device songs: keep them (a memory card or a drive that is not
   * there right now is not the same as deleted songs).
   */
  keepOnEmpty?: boolean;
  /** files left out after their tags were read (desktop/web): too short, or a song the library has another way */
  skipped?: Record<string, SkippedFile>;
}

export interface SkippedFile {
  /** the file as it was (size + date): a changed file is looked at again */
  sig: string;
  why: 'short' | 'duplicate';
}

export const fileSig = (s: Pick<DeviceSong, 'size' | 'modifiedAt'>): string => `${s.size}:${s.modifiedAt}`;

/** 'android:123' -> 'android' */
export const refPlatform = (ref: string): string => ref.slice(0, Math.max(0, ref.indexOf(':')));

export function planDeviceSync(library: Track[], scanned: DeviceSong[], opts: PlanOptions): DevicePlan {
  const excluded = new Set(opts.excluded);
  const skipped = opts.skipped ?? {};
  const skip = (s: DeviceSong) => (skipped[s.ref]?.sig === fileSig(s) ? skipped[s.ref]!.why : undefined);
  const songs = musicOnly(scanned).filter((s) => skip(s) !== 'short');
  const counts = new Map<string, number>();
  for (const s of songs) counts.set(s.folder, (counts.get(s.folder) ?? 0) + 1);
  const folders = [...counts]
    .map(([key, count]) => ({ key, count, included: !excluded.has(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const mine = library.filter((t) => t.source === 'device' && refPlatform(t.ref) === opts.platform);
  const byRef = new Map(mine.map((t) => [t.ref, t]));
  const wanted = songs.filter((s) => !excluded.has(s.folder));
  const wantedRefs = new Set(wanted.map((s) => s.ref));

  const keep = opts.keepOnEmpty !== false && scanned.length === 0 && mine.length > 0;
  const remove = keep ? [] : mine.filter((t) => !wantedRefs.has(t.ref));

  // duplicates: everything else in the library, plus the device songs that stay and the ones added just now
  const index = new DuplicateIndex(library.filter((t) => t.source !== 'device' || wantedRefs.has(t.ref)));
  const files = new Set(library.filter((t) => t.source === 'local' && t.file).map((t) => fileKey(t.file!.name, t.file!.size)));
  const add: DeviceSong[] = [];
  const update: DevicePlan['update'] = [];
  let duplicates = 0;
  for (const s of wanted) {
    const have = byRef.get(s.ref);
    if (have) {
      if (have.file?.size !== s.size || (s.modifiedAt > 0 && have.file?.modifiedAt !== s.modifiedAt)) update.push({ track: have, song: s });
      continue;
    }
    // an imported copy of the very same file, or (tags known) the same song; desktop/web tags come later
    if (skip(s) === 'duplicate' || files.has(fileKey(s.name, s.size)) || isDuplicateSong(index, s)) {
      duplicates++;
      continue;
    }
    if (s.title) rememberSong(index, s);
    add.push(s);
  }
  return { add, remove, update, duplicates, folders, total: wanted.length - duplicates };
}

const fileKey = (name: string, size: number) => `${name.toLowerCase()}\u0000${size}`;

/** Adds a song to the duplicate check (two copies of one song in two folders count once). */
export function rememberSong(index: DuplicateIndex, s: Pick<DeviceSong, 'title' | 'artist' | 'album' | 'durationMs'>): void {
  index.add({ title: s.title ?? '', artist: s.artist ?? '', album: s.album ?? '', durationMs: s.durationMs, source: 'device' } as Track);
}

/** The song is already in the library (title, artist and album, duration within 2 s). */
export function isDuplicateSong(index: DuplicateIndex, s: Pick<DeviceSong, 'title' | 'artist' | 'album' | 'durationMs'>): boolean {
  return Boolean(s.title && index.find({ title: s.title, artist: s.artist ?? '', album: s.album ?? '', durationMs: s.durationMs }));
}
