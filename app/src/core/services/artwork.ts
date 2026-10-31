import { serverLibrary } from '../api';
import { getBlob } from '../db';

const artUrls = new Map<string, string>();

/** artworkId of a server library cover: resolved against the current server URL at display time. */
export const SERVER_ART_PREFIX = 'srv-art:';

/**
 * URL for a track/playlist artwork id: a blobs.id (object URL, cached for the session), a server library cover
 * ('srv-art:<id>') or a plain http(s)/relative URL (remote covers).
 */
export async function artworkUrl(artworkId: string | undefined): Promise<string | undefined> {
  if (!artworkId) return undefined;
  if (artworkId.startsWith(SERVER_ART_PREFIX)) return serverLibrary.artUrl(artworkId.slice(SERVER_ART_PREFIX.length));
  if (/^(https?:|data:|\/)/i.test(artworkId)) return artworkId;
  const cached = artUrls.get(artworkId);
  if (cached) return cached;
  const rec = await getBlob(artworkId);
  if (!rec) return undefined;
  const url = URL.createObjectURL(rec.blob);
  artUrls.set(artworkId, url);
  return url;
}

/** Forget a cached object URL (call after deleting the blob). */
export function releaseArtworkUrl(artworkId: string): void {
  const url = artUrls.get(artworkId);
  if (url) URL.revokeObjectURL(url);
  artUrls.delete(artworkId);
}
