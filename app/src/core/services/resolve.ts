// Track -> playable URL for the HTML audio adapter. YouTube/Spotify tracks play through their own adapters.
import { serverLibrary } from '../api';
import { getBlob } from '../db';
import type { Track } from '../types';
import { subsonicStreamUrl } from './subsonic/store';

const blobUrls = new Map<string, string>();
let serverKey: Promise<unknown> | undefined;

/** Server stream URLs carry a per-user key that comes with the track list; fetch it once per session if needed. */
async function serverStreamUrl(id: string): Promise<string> {
  let url = serverLibrary.streamUrl(id);
  if (!url.includes('?k=')) {
    serverKey ??= serverLibrary.tracks().catch(() => (serverKey = undefined));
    await serverKey;
    url = serverLibrary.streamUrl(id);
  }
  return url;
}

export async function resolveTrackUrl(track: Track): Promise<string> {
  switch (track.source) {
    case 'local': {
      const cached = blobUrls.get(track.ref);
      if (cached) return cached;
      const rec = await getBlob(track.ref);
      if (!rec) throw new Error(`Audio file missing for "${track.title}"`);
      const url = URL.createObjectURL(rec.blob);
      blobUrls.set(track.ref, url);
      return url;
    }
    case 'server':
      return serverStreamUrl(track.ref);
    case 'stream':
      return track.ref;
    case 'subsonic':
      return subsonicStreamUrl(track.ref);
    case 'spotify':
    case 'youtube':
      throw new Error(`${track.source} tracks play through their own adapter`);
  }
}

/** Free a cached blob URL (call when a local track is deleted). */
export function releaseTrackUrl(ref: string): void {
  const url = blobUrls.get(ref);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(ref);
}
