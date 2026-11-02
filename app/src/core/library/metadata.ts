// Song metadata and cover art from the file itself (music-metadata, browser build).
import type { IAudioMetadata, IPicture } from 'music-metadata';
import { VARIOUS_ARTISTS } from './group';
import { titleFromFileName } from './text';

export interface SongMeta {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  year?: number;
  genre?: string;
  trackNo?: number;
  discNo?: number;
  durationMs: number;
  picture?: { data: Uint8Array; mime: string };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

function pickCover(pics: IPicture[] | undefined): IPicture | undefined {
  if (!pics?.length) return undefined;
  return pics.find((p) => /front/i.test(p.type ?? '')) ?? pics[0];
}

export async function readSongMeta(file: File): Promise<SongMeta> {
  let meta: IAudioMetadata | undefined;
  try {
    // loaded on first import only (keeps the parsers out of the start-up bundle)
    const { parseBlob } = await import('music-metadata');
    meta = await parseBlob(file, { duration: true, skipPostHeaders: true });
  } catch (err) {
    console.warn('[hostcaster] could not read tags of', file.name, err);
  }
  const song = songMetaFrom(meta, file.name);
  if (!song.durationMs) song.durationMs = await probeBlobDuration(file);
  return song;
}

/**
 * Tags from the first bytes of a file that stays where it is (a music folder on the computer): `size` is the whole
 * file's, so the duration estimate is right; without one the browser decoder measures `url`.
 */
export async function readSongMetaFromHead(head: Uint8Array, file: { name: string; size: number; mime: string }, url: string): Promise<SongMeta> {
  let meta: IAudioMetadata | undefined;
  try {
    const { parseBuffer } = await import('music-metadata');
    meta = await parseBuffer(head, { mimeType: file.mime, size: file.size, path: file.name }, { duration: true, skipPostHeaders: true });
  } catch (err) {
    console.warn('[hostcaster] could not read tags of', file.name, err);
  }
  const song = songMetaFrom(meta, file.name);
  if (!song.durationMs) song.durationMs = await probeDuration(url);
  return song;
}

function songMetaFrom(meta: IAudioMetadata | undefined, name: string): SongMeta {
  const c = meta?.common;
  const cover = pickCover(c?.picture);
  const durationMs = meta?.format.duration ? Math.round(meta.format.duration * 1000) : 0;
  const artist = first(c?.artist) ?? first(c?.artists) ?? first(c?.albumartist) ?? 'Unknown artist';
  return {
    title: first(c?.title) ?? titleFromFileName(name),
    artist,
    album: first(c?.album) ?? 'Unknown album',
    // compilation flag (iTunes TCMP / cpil) without an album artist: one album, "Various artists"
    albumArtist: first(c?.albumartist) ?? (c?.compilation ? VARIOUS_ARTISTS : undefined),
    year: c?.year && c.year > 0 ? c.year : undefined,
    genre: first(c?.genre),
    trackNo: c?.track?.no ?? undefined,
    discNo: c?.disk?.no ?? undefined,
    durationMs,
    picture: cover?.data?.length ? { data: cover.data, mime: normalizeImageMime(cover.format) } : undefined,
  };
}

function normalizeImageMime(format: string | undefined): string {
  const f = (format ?? '').toLowerCase();
  if (f.includes('png')) return 'image/png';
  if (f.includes('webp')) return 'image/webp';
  if (f.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

/** Duration from the browser decoder when the tags have none. */
async function probeBlobDuration(file: Blob): Promise<number> {
  if (typeof Audio === 'undefined') return 0;
  const url = URL.createObjectURL(file);
  try {
    return await probeDuration(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function probeDuration(url: string): Promise<number> {
  if (typeof Audio === 'undefined') return Promise.resolve(0);
  return new Promise((resolve) => {
    const el = new Audio();
    const done = (ms: number) => {
      clearTimeout(timer);
      el.removeAttribute('src');
      resolve(ms);
    };
    const timer = setTimeout(() => done(0), 8000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => done(0);
    el.src = url;
  });
}
