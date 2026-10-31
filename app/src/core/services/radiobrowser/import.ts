// Internet radio stations -> Host-Caster 'stream' tracks (ref = stream URL, durationMs 0 = live) and stations.
import { db, kvGet, kvSet } from '../../db';
import type { Station, Track } from '../../types';
import { createStationFor, findStationWith, upsertTracks, type TrackDraft } from '../imports';
import { countryName, radioBrowser, type RadioStation } from './client';

const SAVED_KEY = 'radiobrowser:saved';

export interface SavedRadio {
  uuid: string;
  trackId: string;
  name: string;
  favicon?: string;
  homepage?: string;
  savedAt: number;
  /** the directory row when it was saved, so Saved shows offline and without a lookup */
  station?: RadioStation;
}

export function stationToDraft(st: RadioStation, artworkId?: string): TrackDraft {
  const tagLine = st.tags.slice(0, 3).join(', ');
  const country = countryName(st.countryCode, st.country);
  return {
    title: st.name,
    artist: country ? `Live from ${country}` : 'Internet radio',
    album: tagLine || 'Internet radio',
    genre: st.tags[0],
    durationMs: 0,
    artworkId,
    source: 'stream',
    ref: st.url,
  };
}

/**
 * Station logos live on thousands of random hosts, mostly without CORS, so they are kept as remote URLs (the
 * artwork helper accepts URLs) after a plain <img> probe proves the logo loads. No logo = the default art.
 */
async function stationArt(st: RadioStation): Promise<string | undefined> {
  const url = st.favicon;
  if (!url || typeof Image === 'undefined') return undefined;
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http:')) return undefined;
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(undefined), 6000);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth >= 16 ? url : undefined);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    img.src = url;
  });
}

export async function listSavedRadios(): Promise<SavedRadio[]> {
  return (await kvGet<SavedRadio[]>(SAVED_KEY))?.value ?? [];
}

/** Adds the station to the library as a 'stream' track (idempotent) and remembers it as saved. */
export async function saveRadioToLibrary(st: RadioStation): Promise<Track> {
  const [track] = await upsertTracks([stationToDraft(st, await stationArt(st))]);
  const saved = (await listSavedRadios()).filter((s) => s.uuid !== st.uuid);
  saved.unshift({ uuid: st.uuid, trackId: track!.id, name: st.name, favicon: st.favicon, homepage: st.homepage, savedAt: Date.now(), station: st });
  await kvSet(SAVED_KEY, saved);
  return track!;
}

/**
 * Saved stations for lists, newest first. Uses the snapshot kept at save time; entries saved before snapshots existed
 * are looked up in one batched request (and fall back to what was stored when the directory is unreachable).
 */
export async function savedRadioStations(rb: Pick<typeof radioBrowser, 'byUuids'> = radioBrowser): Promise<RadioStation[]> {
  const saved = await listSavedRadios();
  const missing = saved.filter((s) => !s.station).map((s) => s.uuid);
  let fetched = new Map<string, RadioStation>();
  if (missing.length) {
    const rows = await rb.byUuids(missing).catch(() => [] as RadioStation[]);
    fetched = new Map(rows.map((st) => [st.uuid, st]));
    if (rows.length) {
      await kvSet(
        SAVED_KEY,
        saved.map((s) => (s.station || !fetched.has(s.uuid) ? s : { ...s, station: fetched.get(s.uuid) })),
      );
    }
  }
  const out: RadioStation[] = [];
  for (const s of saved) {
    const st = s.station ?? fetched.get(s.uuid);
    if (st) {
      out.push(st);
      continue;
    }
    const track = await db.tracks.get(s.trackId);
    if (!track) continue;
    out.push({ uuid: s.uuid, name: s.name, url: track.ref, homepage: s.homepage, favicon: s.favicon, tags: [], bitrate: 0, hls: false, votes: 0, clicks: 0, ok: true });
  }
  return out;
}

/** Removes the saved stream track (and from playlists it was in). */
export async function removeSavedRadio(uuid: string): Promise<void> {
  const saved = await listSavedRadios();
  const hit = saved.find((s) => s.uuid === uuid);
  await kvSet(
    SAVED_KEY,
    saved.filter((s) => s.uuid !== uuid),
  );
  if (!hit) return;
  await db.transaction('rw', [db.tracks, db.playlists], async () => {
    await db.tracks.delete(hit.trackId);
    await db.playlists
      .filter((p) => p.trackIds.includes(hit.trackId))
      .modify((p) => {
        p.trackIds = p.trackIds.filter((id) => id !== hit.trackId);
      });
  });
}

/** A track to play right away without saving (not stored; id is stable per station). */
export function previewTrack(st: RadioStation): Track {
  const now = Date.now();
  return { ...stationToDraft(st), id: `radio-preview:${st.uuid}`, createdAt: now, updatedAt: now, playCount: 0, addedAt: now };
}

/** Makes a Host-Caster station (your hosts + this stream as the music source); reuses one that already plays it. */
export async function makeRadioStation(st: RadioStation): Promise<Station> {
  const track = await saveRadioToLibrary(st);
  void radioBrowser.countClick(st.uuid);
  const source = { kind: 'stream' as const, ref: track.id };
  const existing = await findStationWith(source);
  if (existing) return existing;
  return createStationFor({
    name: st.name,
    description: [st.tags.slice(0, 3).join(', '), countryName(st.countryCode, st.country)].filter(Boolean).join(' · ') || 'Internet radio',
    sources: [source],
    seed: st.uuid,
    talkEvery: 3,
    talkLength: 'short',
    talkOverIntro: false,
    shuffle: false,
  });
}
