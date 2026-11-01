// Test fixtures for the radio brain (used by *.test.ts only).
import { STARTER_HOSTS, STARTER_STATION, defaultSegments } from '../db/defaults';
import type { Break, ContextPacket, Host, Station } from '../types';

/** Deterministic random (mulberry32). */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NOW = new Date(2026, 9, 29, 21, 40).getTime();

export function station(patch: Partial<Station> = {}): Station {
  return { ...STARTER_STATION, createdAt: 0, updatedAt: 0, segments: defaultSegments(), ...patch };
}

export function hosts(n = 2): Host[] {
  return STARTER_HOSTS.slice(0, n).map((h) => ({ ...h, createdAt: 0, updatedAt: 0 }));
}

export function packet(patch: Partial<ContextPacket> = {}): ContextPacket {
  const d = new Date(NOW);
  return {
    now: { iso: d.toISOString(), local: d.toString(), partOfDay: 'night', weekday: 'Thursday' },
    listener: { name: 'Sam Rivera', callMe: 'Sam', about: 'Night-shift nurse who loves 80s synth-pop', interests: ['running'], avoid: ['politics'] },
    songBefore: { id: 't1', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming', durationMs: 240_000, source: 'local' },
    songAfter: { id: 't2', title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', durationMs: 257_000, source: 'local' },
    upcomingSongs: [],
    weather: { place: 'Lisbon', temperature: 18, feelsLike: 17, condition: 'partly cloudy', high: 21, low: 14, precipitationChance: 10, units: 'metric', fetchedAt: NOW },
    calendar: [{ id: 'dentist', title: 'Dentist', start: NOW + 40 * 60_000, end: NOW + 100 * 60_000, allDay: false, source: 'ics' }],
    email: [{ id: 'm1', from: 'Ana Costa <ana@example.com>', subject: 'Re: Saturday brunch plans 20261031', important: true, at: NOW - 3600_000 }],
    news: [{ id: 'news:abc', title: 'City opens new riverside park', source: 'Lisbon Daily' }],
    lifeEvents: [{ id: 'bd', title: "Mom's birthday", date: '1961-10-30', yearly: true }],
    notes: ['Water the plants'],
    reminders: [{ id: 'r1', text: 'Call the pharmacy', at: NOW + 20 * 60_000 }],
    recentBreaks: [],
    ...patch,
  };
}

export function pastBreak(topics: string[], minutesAgo: number, text = 'Hello there'): Break {
  return {
    id: `b${minutesAgo}`,
    createdAt: 0,
    updatedAt: 0,
    stationId: STARTER_STATION.id,
    at: NOW - minutesAgo * 60_000,
    lines: [{ hostId: STARTER_HOSTS[0]!.id, text }],
    topics,
  };
}

/** A rundown aired five minutes ago (same hour as NOW): the next regular break is an ordinary one. */
export const settled = (): Break[] => [pastBreak(['rundown'], 5)];
