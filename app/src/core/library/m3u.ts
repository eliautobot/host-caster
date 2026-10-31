// M3U / M3U8 / PLS playlist files: parse, match entries to library tracks, export (pure).
import type { Track } from '../types';
import { baseName, extOf, norm, splitArtistTitle, stripExt, titleFromFileName } from './text';

export interface PlaylistEntry {
  /** path, file name or URL as written in the file */
  location: string;
  title?: string;
  artist?: string;
  durationSec?: number;
}

export interface ParsedPlaylist {
  name?: string;
  entries: PlaylistEntry[];
}

export const PLAYLIST_EXTS = ['m3u', 'm3u8', 'pls'];

const clean = (text: string) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

export function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:/i.test(s);
}

/** Splits '#EXTINF:123 tvg-name="x, y",Artist - Title' into duration and display text (commas in quotes ok). */
function parseExtInf(line: string): Pick<PlaylistEntry, 'durationSec' | 'title' | 'artist'> {
  const body = line.slice(line.indexOf(':') + 1);
  let inQuote = false;
  let comma = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      comma = i;
      break;
    }
  }
  const head = comma >= 0 ? body.slice(0, comma) : body;
  const display = comma >= 0 ? body.slice(comma + 1).trim() : '';
  const dur = Number.parseFloat(head.trim().split(/\s+/)[0] ?? '');
  const { artist, title } = display ? splitArtistTitle(display) : { artist: undefined, title: '' };
  return { durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined, title: title || undefined, artist };
}

export function parseM3U(text: string): ParsedPlaylist {
  const out: ParsedPlaylist = { entries: [] };
  let pending: Omit<PlaylistEntry, 'location'> = {};
  for (const raw of clean(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) pending = parseExtInf(line);
      else if (/^#PLAYLIST:/i.test(line)) out.name = line.slice(10).trim() || undefined;
      continue;
    }
    out.entries.push({ location: line, ...pending });
    pending = {};
  }
  return out;
}

export function parsePLS(text: string): ParsedPlaylist {
  const files = new Map<number, PlaylistEntry>();
  const get = (n: number) => {
    let e = files.get(n);
    if (!e) files.set(n, (e = { location: '' }));
    return e;
  };
  for (const raw of clean(text).split('\n')) {
    const m = /^\s*(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const [, key, num, value = ''] = m;
    const e = get(Number(num));
    const v = value.trim();
    switch (key!.toLowerCase()) {
      case 'file':
        e.location = v;
        break;
      case 'title': {
        const { artist, title } = splitArtistTitle(v);
        e.title = title || undefined;
        e.artist = artist;
        break;
      }
      default: {
        const d = Number.parseFloat(v);
        e.durationSec = Number.isFinite(d) && d > 0 ? d : undefined;
      }
    }
  }
  return { entries: [...files.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e).filter((e) => e.location) };
}

/** Picks the parser from the file name, or sniffs the content. */
export function parsePlaylistFile(name: string, text: string): ParsedPlaylist {
  const ext = extOf(name);
  const pls = ext === 'pls' || (ext !== 'm3u' && ext !== 'm3u8' && /^\s*\[playlist\]/i.test(clean(text)));
  const parsed = pls ? parsePLS(text) : parseM3U(text);
  return { ...parsed, name: parsed.name ?? (stripExt(baseName(name)) || undefined) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

export type MatchMethod = 'path' | 'file' | 'stem' | 'tags' | 'title' | 'url';

export interface EntryMatch {
  entry: PlaylistEntry;
  track?: Track;
  method?: MatchMethod;
}

const normPath = (p: string) => {
  let s = p.trim().replace(/\\/g, '/');
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/*/i, '/');
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep as is
    }
  }
  return s.replace(/^\.\//, '').toLowerCase();
};

/** Matches playlist entries to library tracks: by path, file name, name without extension, then tags. */
export function matchEntries(entries: readonly PlaylistEntry[], tracks: readonly Track[]): EntryMatch[] {
  const byFile = new Map<string, Track[]>();
  const byStem = new Map<string, Track[]>();
  const byTags = new Map<string, Track[]>();
  const byTitle = new Map<string, Track[]>();
  const byUrl = new Map<string, Track>();
  const push = (m: Map<string, Track[]>, k: string, t: Track) => {
    if (!k) return;
    const l = m.get(k);
    if (l) l.push(t);
    else m.set(k, [t]);
  };
  for (const t of tracks) {
    if (t.source === 'stream') byUrl.set(t.ref, t);
    if (t.file) {
      push(byFile, t.file.name.toLowerCase(), t);
      push(byStem, norm(stripExt(t.file.name)), t);
    }
    push(byTags, `${norm(t.artist)}\u0000${norm(t.title)}`, t);
    push(byTitle, norm(t.title), t);
  }
  const withPath = tracks.filter((t) => t.file?.path);

  return entries.map((entry): EntryMatch => {
    const loc = entry.location.trim();
    if (isUrl(loc)) {
      const t = byUrl.get(loc) ?? tracks.find((x) => x.ref === loc);
      return t ? { entry, track: t, method: 'url' } : { entry };
    }
    const p = normPath(loc);
    const viaPath = withPath.find((t) => {
      const tp = t.file!.path!.toLowerCase();
      return p === tp || p.endsWith(`/${tp}`);
    });
    if (viaPath) return { entry, track: viaPath, method: 'path' };
    const file = baseName(p);
    const one = (l: Track[] | undefined) => l?.[0];
    const viaFile = one(byFile.get(file));
    if (viaFile) return { entry, track: viaFile, method: 'file' };
    const viaStem = one(byStem.get(norm(stripExt(file))));
    if (viaStem) return { entry, track: viaStem, method: 'stem' };
    const title = entry.title ?? titleFromFileName(file);
    if (entry.artist) {
      const viaTags = one(byTags.get(`${norm(entry.artist)}\u0000${norm(title)}`));
      if (viaTags) return { entry, track: viaTags, method: 'tags' };
    }
    const sameTitle = byTitle.get(norm(title));
    if (sameTitle?.length === 1) return { entry, track: sameTitle[0], method: 'title' };
    return { entry };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Export

/** Where a track lives, for an exported playlist. `serverUrl` builds absolute server-library stream URLs. */
export function trackLocation(t: Track, serverUrl?: (id: string) => string): string {
  switch (t.source) {
    case 'local':
      return t.file?.path ?? t.file?.name ?? `${t.artist} - ${t.title}`;
    case 'stream':
      return t.ref;
    case 'server':
      return serverUrl ? serverUrl(t.ref) : `${t.artist} - ${t.title}`;
    case 'youtube':
      return `https://music.youtube.com/watch?v=${encodeURIComponent(t.ref)}`;
    default:
      return t.ref;
  }
}

export function exportM3U(name: string, tracks: readonly Track[], serverUrl?: (id: string) => string): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${name.replace(/\s+/g, ' ').trim()}`];
  for (const t of tracks) {
    const sec = t.source === 'stream' || !(t.durationMs > 0) ? -1 : Math.round(t.durationMs / 1000);
    lines.push(`#EXTINF:${sec},${t.artist} - ${t.title}`, trackLocation(t, serverUrl));
  }
  return `${lines.join('\n')}\n`;
}

export function playlistFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'playlist';
  return `${safe}.m3u8`;
}
