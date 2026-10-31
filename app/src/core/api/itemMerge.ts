// Synced songs, playlist lists and unplayable marks (pure, no I/O). A song syncs when it is a reference that works on
// any device (YouTube, Spotify, an internet stream, a Subsonic or server library song); files stay on their device.
// Records are keyed by '<source>:<ref>', never by the local track id: two devices that imported the same video hold
// different ids for it.
import type { Track, TrackSource } from '../types';
import { stableStringify } from './merge';

export type ItemKind = 'track' | 'members' | 'unplayable';

/** A record as the server stores it: data, or deleted (a tombstone). */
export interface SyncItem<D = unknown> {
  kind: ItemKind;
  id: string;
  updatedAt: number;
  deleted?: boolean;
  data?: D;
  /** members: the server version this list was edited from (0 = none); the server refuses it when that changed */
  base?: number;
}

export const SYNCED_SOURCES: readonly TrackSource[] = ['youtube', 'spotify', 'stream', 'subsonic', 'server'];
const MAX_KEY = 512;

export const trackKey = (t: Pick<Track, 'source' | 'ref'>): string => `${t.source}:${t.ref}`;

export function isSyncedTrack(t: Pick<Track, 'source' | 'ref'>): boolean {
  return SYNCED_SOURCES.includes(t.source) && Boolean(t.ref) && trackKey(t).length <= MAX_KEY;
}

/** 'spotify:spotify:track:1' -> ['spotify', 'spotify:track:1'] */
export function splitKey(key: string): [TrackSource, string] | undefined {
  const i = key.indexOf(':');
  if (i <= 0) return undefined;
  const source = key.slice(0, i) as TrackSource;
  return SYNCED_SOURCES.includes(source) && i < key.length - 1 ? [source, key.slice(i + 1)] : undefined;
}

/** What travels for a song: its tags and where it comes from; play counts, files and local cover blobs stay here. */
export interface TrackData {
  /** its id on the device that added it: another device uses the same id when free (stations point at stream ids) */
  id?: string;
  source: TrackSource;
  ref: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  year?: number;
  genre?: string;
  durationMs: number;
  trackNo?: number;
  discNo?: number;
  liked?: boolean;
  addedAt: number;
  createdAt: number;
  /** a public cover URL */
  art?: string;
}

const youTubeThumb = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** A cover another device can load: a remote URL or the server library's own cover id, never a blob on this device. */
export function portableArt(t: Pick<Track, 'artworkId' | 'artUrl' | 'source' | 'ref'>): string | undefined {
  if (t.artUrl) return t.artUrl;
  if (t.artworkId && /^(https?:\/\/|srv-art:)/i.test(t.artworkId)) return t.artworkId;
  if (t.source === 'youtube') return youTubeThumb(t.ref);
  return undefined;
}

export function trackData(t: Track): TrackData {
  const d: TrackData = {
    id: t.id,
    source: t.source,
    ref: t.ref,
    title: t.title,
    artist: t.artist,
    album: t.album ?? '',
    albumArtist: t.albumArtist,
    year: t.year,
    genre: t.genre,
    durationMs: t.durationMs || 0,
    trackNo: t.trackNo,
    discNo: t.discNo,
    liked: t.liked || undefined,
    addedAt: t.addedAt,
    createdAt: t.createdAt,
    art: portableArt(t),
  };
  for (const k of Object.keys(d) as (keyof TrackData)[]) if (d[k] === undefined) delete d[k];
  return d;
}

/**
 * The local row for a pulled song: tags from the record, this device's id, play stats and cover kept (a new song takes
 * the id it has elsewhere when `idFree` says this device does not use it). A cover that is only a URL shows as that
 * URL until an import stores it here.
 */
export function trackFromData(d: TrackData, prev: Track | undefined, newId: () => string, updatedAt: number, idFree: (id: string) => boolean = () => false): Track {
  const art = d.art && !d.art.startsWith('srv-art:') ? d.art : undefined;
  return {
    ...(prev ?? {}),
    id: prev?.id ?? (d.id && idFree(d.id) ? d.id : newId()),
    source: d.source,
    ref: d.ref,
    title: d.title,
    artist: d.artist,
    album: d.album ?? '',
    albumArtist: d.albumArtist,
    year: d.year,
    genre: d.genre,
    durationMs: d.durationMs || 0,
    trackNo: d.trackNo,
    discNo: d.discNo,
    liked: d.liked || undefined,
    addedAt: prev?.addedAt ?? d.addedAt ?? updatedAt,
    createdAt: prev?.createdAt ?? d.createdAt ?? updatedAt,
    updatedAt,
    playCount: prev?.playCount ?? 0,
    lastPlayedAt: prev?.lastPlayedAt,
    artworkId: prev?.artworkId ?? (d.art?.startsWith('srv-art:') ? d.art : art),
    artUrl: art ?? prev?.artUrl,
  };
}

/**
 * Hash of a song's record for "did it change since it was synced". When it was added and its id are left out: two
 * devices that imported the same song at different times hold the same song.
 */
export function dataHash(d: TrackData): string {
  const { addedAt: _a, createdAt: _c, id: _i, ...rest } = d;
  return quickHash(rest);
}

/** Fast content hash (two 32-bit FNV-1a lanes; equality checks only, not security). */
export function quickHash(value: unknown): string {
  const s = typeof value === 'string' ? value : stableStringify(value);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519) ^ (b >>> 13);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

// ---- playlist lists -------------------------------------------------------------------------------------------------

/** A song that stays on its device travels as '#<its track id>' (other devices count it, they cannot play it). */
const DEVICE_ONLY = '#';

/** Local track ids -> the list as it syncs (song keys, '#id' for files, unknown ids kept as they are). */
export function wireMembers(trackIds: string[], byId: Map<string, Pick<Track, 'source' | 'ref'>>): string[] {
  return trackIds.map((id) => {
    const t = byId.get(id);
    if (t) return isSyncedTrack(t) ? trackKey(t) : `${DEVICE_ONLY}${id}`;
    // not here: a song key from another device stays a key; a file from another device stays its '#id'
    return splitKey(id) ? id : `${DEVICE_ONLY}${id}`;
  });
}

/** The synced list -> local track ids (a key with no song here, or another device's file, keeps its place). */
export function localMembers(keys: string[], idByKey: Map<string, string>): string[] {
  return keys.map((k) => (k.startsWith(DEVICE_ONLY) ? k.slice(1) : (idByKey.get(k) ?? k)));
}

/**
 * Three-way merge of two edited copies of one list: the other device's order, minus what this device removed, plus
 * what this device added (each after the song it followed here).
 */
export function mergeLists(base: string[], local: string[], remote: string[]): string[] {
  const inBase = new Set(base);
  const inLocal = new Set(local);
  const removedHere = new Set(base.filter((k) => !inLocal.has(k)));
  const out = remote.filter((k) => !removedHere.has(k));
  const have = new Set(out);
  for (let i = 0; i < local.length; i++) {
    const k = local[i]!;
    if (inBase.has(k) || have.has(k)) continue;
    // after the nearest earlier song of this list that is in the result, else at the start
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.lastIndexOf(local[j]!);
      if (p >= 0) {
        at = p + 1;
        break;
      }
    }
    out.splice(at, 0, k);
    have.add(k);
  }
  return out;
}

export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
