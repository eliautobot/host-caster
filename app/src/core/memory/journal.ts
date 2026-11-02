// The short-term memory: a compact per-day log of what happened on the radio (what the listener said, heads-ups
// and "got it", songs liked, skipped early or asked for, stations and hours, what the hosts covered), 14 days on
// this device, then gone. No audio, one short line per row. The switches in Settings decide what is written.
import { db } from '../db/db';
import type { JournalEntry, JournalKind, Settings, Track } from '../types';
import { newId } from '../util/id';
import { memoryEvents } from './store';
import { dayKey } from './text';

export const JOURNAL_DAYS = 14;
const DAY = 86_400_000;
const WORDS: ReadonlySet<JournalKind> = new Set<JournalKind>(['said', 'app']);

/** The two switches (both on unless turned off). */
export function memorySwitches(settings: Pick<Settings, 'connections'> | undefined): { fromWords: boolean; fromListening: boolean } {
  const m = settings?.connections?.memory;
  return { fromWords: m?.fromWords !== false, fromListening: m?.fromListening !== false };
}

let prunedAt = 0;

/** Writes one row (or replaces the row with the same id). Never throws. */
export async function journal(kind: JournalKind, text: string, extra: Partial<Omit<JournalEntry, 'kind' | 'text'>> = {}): Promise<JournalEntry | undefined> {
  try {
    const sw = memorySwitches(await db.settings.get('app'));
    if (WORDS.has(kind) ? !sw.fromWords : kind === 'headsup' || kind === 'covered' ? !sw.fromWords && !sw.fromListening : !sw.fromListening) return undefined;
    const at = extra.at ?? Date.now();
    const entry: JournalEntry = { id: extra.id ?? `j_${newId()}`, at, day: dayKey(at), kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 240), ...extra };
    entry.at = at;
    entry.day = dayKey(at);
    await db.journal.put(entry);
    if (Date.now() - prunedAt > 3600_000) {
      prunedAt = Date.now();
      await pruneJournal();
    }
    memoryEvents.emit('journal', { entry });
    return entry;
  } catch (err) {
    console.warn('[hostcaster] journal', err);
    return undefined;
  }
}

/** Drops rows older than 14 days. */
export async function pruneJournal(now = Date.now()): Promise<number> {
  return db.journal.where('at').below(now - JOURNAL_DAYS * DAY).delete();
}

/** The journal, newest first (at most `days` days back). */
export async function listJournal(days = JOURNAL_DAYS, now = Date.now()): Promise<JournalEntry[]> {
  const rows = await db.journal.where('at').aboveOrEqual(now - days * DAY).toArray();
  return rows.sort((a, b) => b.at - a.at);
}

export async function deleteJournal(id: string): Promise<void> {
  await db.journal.delete(id);
  memoryEvents.emit('journal', {});
}

// ---- what the radio notes --------------------------------------------------------------------------------------------

const song = (t: Pick<Track, 'title' | 'artist'>) => `${t.title}${t.artist ? ` by ${t.artist}` : ''}`;
const hourWords = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' });

export const noteSaid = (said: string, from: 'call' | 'app' = 'call') => journal(from === 'app' ? 'app' : 'said', said);
export const noteLiked = (t: Track) => journal('liked', song(t), { artist: t.artist || undefined, genre: t.genre || undefined, id: `liked:${t.id}:${dayKey(Date.now())}` });
export const noteRequested = (t: Pick<Track, 'title' | 'artist' | 'genre'>) => journal('requested', song(t), { artist: t.artist || undefined, genre: t.genre || undefined });
export const noteHeadsUp = (said: string) => journal('headsup', said);
export const noteGotIt = (what: string) => journal('gotit', what);

/** A song the listener skipped: early = in the first third (and before 90 s left). Only early skips are kept. */
export function noteSkip(t: Track, positionMs: number, durationMs: number): Promise<JournalEntry | undefined> {
  const early = durationMs > 0 ? positionMs < durationMs / 3 : positionMs < 60_000;
  if (!early) return Promise.resolve(undefined);
  return journal('skipped', song(t), { artist: t.artist || undefined, genre: t.genre || undefined });
}

/** The station and the hour (one row per station per hour per day). */
export function noteListening(stationId: string, stationName: string, now = Date.now()): Promise<JournalEntry | undefined> {
  const h = new Date(now).getHours();
  return journal('listened', `Listened to ${stationName} around ${hourWords(now)}`, { id: `listened:${dayKey(now)}:${h}:${stationId}`, stationId, at: now });
}

/** What a break covered, or that the listener skipped it (with its segments: "skips the news before 9 AM"). */
export function noteBreak(segments: string[], gist: string, skipped: boolean, stationId?: string): Promise<JournalEntry | undefined> {
  const segs = [...new Set(segments)].filter((s) => s !== 'time');
  if (skipped) return journal('breakSkipped', `Skipped the hosts${segs.length ? ` (${segs.join(', ')})` : ''}`, { segments: segs, stationId });
  if (!gist) return Promise.resolve(undefined);
  return journal('covered', gist, { segments: segs, stationId });
}
