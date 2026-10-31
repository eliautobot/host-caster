// Shared import helpers for the music services (owner: services builder).
// Imported songs become normal `tracks` rows; re-importing updates them in place (dedupe on [source+ref]), so
// likes, play counts and playlist membership survive a refresh.
import { db, getBlob, kvGet, kvSet, putBlob } from '../../db';
import type { Draft, Playlist, PlaylistSource, Track } from '../../types';
import { newId } from '../../util/id';

export type TrackDraft = Omit<Draft<Track>, 'playCount' | 'addedAt'> & Partial<Pick<Track, 'playCount' | 'addedAt'>>;

/** Insert or update tracks, keeping the existing id, likes and play stats. Returns rows in input order. */
export async function upsertTracks(drafts: TrackDraft[]): Promise<Track[]> {
  if (!drafts.length) return [];
  const now = Date.now();
  const pairs = drafts.map((d) => [d.source, d.ref] as [string, string]);
  const existing = await db.tracks.where('[source+ref]').anyOf(pairs).toArray();
  const byKey = new Map(existing.map((t) => [`${t.source}\u0000${t.ref}`, t]));
  const seen = new Map<string, Track>();
  const out: Track[] = [];
  for (const d of drafts) {
    const key = `${d.source}\u0000${d.ref}`;
    const dup = seen.get(key);
    if (dup) {
      out.push(dup);
      continue;
    }
    const prev = byKey.get(key);
    const rec: Track = {
      ...(prev ?? {}),
      ...d,
      id: prev?.id ?? newId(),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      playCount: prev?.playCount ?? d.playCount ?? 0,
      lastPlayedAt: prev?.lastPlayedAt,
      addedAt: prev?.addedAt ?? d.addedAt ?? now,
      liked: d.liked || prev?.liked || undefined,
      // a stored cover stays; a new song without one shows its public cover URL
      artworkId: d.artworkId ?? prev?.artworkId ?? d.artUrl,
      artUrl: d.artUrl ?? prev?.artUrl,
    };
    seen.set(key, rec);
    out.push(rec);
  }
  await db.tracks.bulkPut([...seen.values()]);
  return out;
}

export interface ImportedPlaylistInput {
  name: string;
  description?: string;
  trackIds: string[];
  source: PlaylistSource;
  coverId?: string;
}

const mapKey = (key: string) => `import:playlist:${key}`;

/**
 * The playlist a remote one was imported into: this device's own import, else one the account's other device made
 * (synced, marked with remoteKey; older ones by source and name), so importing again fills it instead of doubling it.
 */
async function importedPlaylist(key: string, match?: Pick<Playlist, 'source' | 'name'>): Promise<Playlist | undefined> {
  const mapped = await kvGet<string>(mapKey(key));
  const own = mapped ? await db.playlists.get(mapped.value) : undefined;
  if (own) return own;
  return db.playlists
    .filter((p) => p.remoteKey === key || (Boolean(match) && !p.remoteKey && p.source === match!.source && p.name === match!.name))
    .first();
}

/** Create or refresh the Host-Caster playlist mirrored from a remote one. `key` = e.g. 'spotify:37i9dQ...'. */
export async function upsertImportedPlaylist(key: string, input: ImportedPlaylistInput): Promise<Playlist> {
  const prev = await importedPlaylist(key, input);
  const now = Date.now();
  const rec: Playlist = {
    ...input,
    id: prev?.id ?? newId(),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    coverId: input.coverId ?? prev?.coverId,
    remoteKey: key,
  };
  await db.playlists.put(rec);
  if ((await kvGet<string>(mapKey(key)))?.value !== rec.id) await kvSet(mapKey(key), rec.id);
  return rec;
}

/** The local playlist id a remote playlist was imported into, if any. */
export async function importedPlaylistId(key: string): Promise<string | undefined> {
  return (await importedPlaylist(key))?.id;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Downloads cover art into `blobs` under a stable id (so one album cover is stored once and works offline).
 * Returns the blob id, or undefined when the image cannot be fetched (CORS, 404, not an image).
 */
export async function storeArt(id: string, url: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
  if (await getBlob(id)) return id;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000), credentials: 'omit' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    const type = blob.type || res.headers.get('content-type') || '';
    if (!type.startsWith('image/') || blob.size === 0 || blob.size > 4_000_000) return undefined;
    await putBlob(blob, id);
    return id;
  } catch {
    return undefined;
  }
}

/** Runs `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Stores each distinct cover once; returns url -> blob id. */
export async function storeArtMany(
  arts: { id: string; url: string }[],
  fetchImpl?: FetchLike,
  limit = 4,
): Promise<Map<string, string>> {
  const unique = [...new Map(arts.map((a) => [a.id, a])).values()];
  const ids = await mapLimit(unique, limit, (a) => storeArt(a.id, a.url, fetchImpl));
  const out = new Map<string, string>();
  unique.forEach((a, i) => {
    const got = ids[i];
    if (got) out.set(a.id, got);
  });
  return out;
}
