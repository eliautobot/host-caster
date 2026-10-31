// Station sources -> the player queue. Streams are the whole station (endless); 'anyapp' hands playback to another app.
import { api, serverLibrary } from '../api';
import { getPlaylist, getTrack, listTracks } from '../db';
import { unplayableIds } from '../player/unplayable';
import type { ServerTrack, Station, Track } from '../types';

export interface StationQueue {
  /** songs (shuffled when the station shuffles) */
  tracks: Track[];
  /** an endless stream: no song ends, breaks run on a timer */
  live: boolean;
  /** another app plays the music (Android) */
  anyApp: boolean;
}

export function shuffled<T>(list: T[], rand: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function fromServer(t: ServerTrack): Track {
  const now = Date.now();
  return { ...t, id: `server:${t.id}`, source: 'server', ref: t.id, playCount: 0, addedAt: now, createdAt: now, updatedAt: now };
}

export async function stationQueue(station: Station, rand: () => number = Math.random): Promise<StationQueue> {
  if (station.sources.some((s) => s.kind === 'anyapp')) return { tracks: [], live: false, anyApp: true };
  const all = await listTracks();
  const byId = new Map(all.map((t) => [t.id, t]));
  const picked: Track[] = [];
  const add = (t: Track | undefined) => t && picked.push(t);

  for (const src of station.sources) {
    switch (src.kind) {
      case 'stream': {
        const t = src.ref ? (byId.get(src.ref) ?? (await getTrack(src.ref))) : undefined;
        if (t) return { tracks: [t], live: true, anyApp: false };
        break;
      }
      case 'library':
        all.filter((t) => t.source !== 'stream').forEach(add);
        break;
      case 'liked':
        all.filter((t) => t.liked && t.source !== 'stream').forEach(add);
        break;
      case 'server': {
        const local = all.filter((t) => t.source === 'server');
        if (local.length) local.forEach(add);
        else if (api.available) (await serverLibrary.tracks().catch(() => ({ tracks: [] }))).tracks.map(fromServer).forEach(add);
        break;
      }
      case 'playlist':
      case 'spotify-playlist':
      case 'youtube-playlist': {
        const pl = src.ref ? await getPlaylist(src.ref) : undefined;
        pl?.trackIds.forEach((id) => add(byId.get(id)));
        break;
      }
      default:
        break;
    }
  }
  const seen = new Set<string>();
  const unique = picked.filter((t) => !seen.has(t.id) && seen.add(t.id));
  // songs known not to play here (YouTube embedding off, removed ...) are left out; if that leaves nothing, the
  // player tries them and says why
  const blocked = await unplayableIds().catch(() => new Set<string>());
  const playable = unique.filter((t) => !blocked.has(t.id));
  const list = playable.length ? playable : unique;
  return { tracks: station.shuffle ? shuffled(list, rand) : list, live: false, anyApp: false };
}

/** Repeats the list (reshuffling each round) so a station plays for hours. */
export function extendQueue(tracks: Track[], shuffle: boolean, minCount = 60, rand: () => number = Math.random): Track[] {
  if (!tracks.length) return [];
  const out = [...tracks];
  while (out.length < minCount) {
    let round = shuffle ? shuffled(tracks, rand) : tracks;
    // avoid the same song twice in a row at the seam
    if (round.length > 1 && round[0]!.id === out[out.length - 1]!.id) round = [...round.slice(1), round[0]!];
    out.push(...round);
  }
  return out;
}
