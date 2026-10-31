// Internet radio: a stream URL becomes an endless track (source 'stream', ref = URL, duration 0).
import { api, integrations } from '../api';
import { db, saveTracks } from '../db';
import type { Track } from '../types';
import { parsePlaylistFile } from './m3u';
import { extOf } from './text';

export interface StreamInput {
  url: string;
  name?: string;
}

export function normalizeStreamUrl(input: string): string {
  const raw = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http or https address');
  return url.href;
}

/** A .pls/.m3u link (what many stations publish) -> the first real stream URL inside it. */
export async function resolveStreamUrl(url: string): Promise<string> {
  const ext = extOf(new URL(url).pathname);
  if (!['pls', 'm3u', 'm3u8'].includes(ext)) return url;
  if (ext === 'm3u8') {
    // HLS playlists are played directly by browsers that support them; plain .m3u8 lists hold stream URLs
    const text = await fetchText(url).catch(() => undefined);
    if (!text || /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/i.test(text)) return url;
    return firstUrl(url, text) ?? url;
  }
  const text = await fetchText(url);
  const found = firstUrl(url, text);
  if (!found) throw new Error('No stream found in that playlist link');
  return found;
}

function firstUrl(name: string, text: string): string | undefined {
  return parsePlaylistFile(name, text).entries.find((e) => /^https?:\/\//i.test(e.location))?.location;
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.text();
  } catch {
    // CORS or network: ask the server
  }
  if (!api.available) throw new Error('Could not open that playlist link (try the direct stream address)');
  return (await integrations.fetchText(url)).text;
}

/** Adds streams (skipping ones already in the library) and returns the new tracks. */
export async function addStreams(inputs: StreamInput[]): Promise<Track[]> {
  const out: Track[] = [];
  const now = Date.now();
  for (const s of inputs) {
    const url = normalizeStreamUrl(s.url);
    const existing = await db.tracks.where('[source+ref]').equals(['stream', url]).first();
    if (existing) continue;
    const host = new URL(url).hostname.replace(/^www\./, '');
    const [t] = await saveTracks([
      {
        title: s.name?.trim() || host,
        artist: 'Internet radio',
        album: host,
        durationMs: 0,
        source: 'stream',
        ref: url,
        playCount: 0,
        addedAt: now,
      },
    ]);
    out.push(t!);
  }
  return out;
}

/** Adds one stream from what the user typed; returns the library track (new or existing). */
export async function addStream(input: string, name?: string): Promise<Track> {
  const url = await resolveStreamUrl(normalizeStreamUrl(input));
  const [added] = await addStreams([{ url, name }]);
  if (added) return added;
  const existing = await db.tracks.where('[source+ref]').equals(['stream', url]).first();
  if (!existing) throw new Error('Could not add that stream');
  return existing;
}
