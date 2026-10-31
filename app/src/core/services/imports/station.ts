// Makes a Host-Caster station from a music-service source (imported playlist, radio stream, any-app mode).
import { db, defaultSegments, getSettings, listHosts, saveStation } from '../../db';
import type { Station, StationSource } from '../../types';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** warm/neutral station colours (no purple) */
const STATION_COLORS = ['#ff5a36', '#ffb020', '#e2725b', '#c2410c', '#0f766e', '#2563eb', '#16a34a', '#b45309'];

export interface StationFromSource {
  name: string;
  description?: string;
  sources: StationSource[];
  /** seeds the colour and the frequency so the same source always looks the same */
  seed: string;
  talkEvery?: number;
  talkLength?: Station['talkLength'];
  talkOverIntro?: boolean;
  shuffle?: boolean;
}

/** Uses the hosts of the active station (or the first two hosts) so the new station sounds familiar. */
export async function createStationFor(input: StationFromSource): Promise<Station> {
  const settings = await getSettings();
  const active = settings.activeStationId ? await db.stations.get(settings.activeStationId) : undefined;
  const hosts = active?.hostIds.length ? active.hostIds : (await listHosts()).slice(0, 2).map((h) => h.id);
  const h = hash(input.seed);
  // 87.5-107.9 FM, seeded by the source; step to the next free one so two stations never share a frequency
  const used = new Set((await db.stations.toArray()).map((s) => s.frequency));
  let slot = h % 205;
  for (let i = 0; i < 205 && used.has((87.5 + slot / 10).toFixed(1)); i++) slot = (slot + 1) % 205;
  return saveStation({
    name: input.name,
    frequency: (87.5 + slot / 10).toFixed(1),
    color: STATION_COLORS[h % STATION_COLORS.length]!,
    description: input.description,
    sources: input.sources,
    hostIds: hosts.slice(0, 4),
    talkEvery: input.talkEvery ?? 2,
    talkLength: input.talkLength ?? 'normal',
    segments: defaultSegments(),
    talkOverIntro: input.talkOverIntro ?? true,
    duckLevel: 0.18,
    newsFeeds: [],
    shuffle: input.shuffle ?? true,
  });
}

/** The first station already using this exact source, if any (avoid duplicates on repeated taps). */
export async function findStationWith(source: StationSource): Promise<Station | undefined> {
  return db.stations.filter((s) => s.sources.some((x) => x.kind === source.kind && (x.ref ?? '') === (source.ref ?? ''))).first();
}
