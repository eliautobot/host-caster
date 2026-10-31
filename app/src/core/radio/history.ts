// On-air history: breaks that aired, newest first, grouped by day for the history screen.
import { db } from '../db';
import type { Break } from '../types';

/** Newest first, across stations or for one station. */
export function recentBreaks(limit = 50, stationId?: string): Promise<Break[]> {
  if (stationId) {
    return db.breaks.where('[stationId+at]').between([stationId, -Infinity], [stationId, Infinity]).reverse().limit(limit).toArray();
  }
  return db.breaks.orderBy('at').reverse().limit(limit).toArray();
}

export async function deleteBreak(id: string): Promise<void> {
  await db.breaks.delete(id);
}

/** Clears the history (one station, or all). The planner then forgets which topics were used recently. */
export async function clearBreaks(stationId?: string): Promise<void> {
  if (stationId) await db.breaks.where('stationId').equals(stationId).delete();
  else await db.breaks.clear();
}

export interface BreakDay {
  key: string;
  label: string;
  breaks: Break[];
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Today", "Yesterday", "Monday", then "March 3". */
export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function groupByDay(breaks: Break[], now = Date.now()): BreakDay[] {
  const out: BreakDay[] = [];
  for (const b of breaks) {
    const key = dayKey(b.at);
    let day = out[out.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(b.at, now), breaks: [] };
      out.push(day);
    }
    day.breaks.push(b);
  }
  return out;
}

const TOPIC_LABELS: Record<string, string> = {
  songs: 'Songs',
  time: 'Time',
  weather: 'Weather',
  calendar: 'Calendar',
  email: 'Email',
  news: 'News',
  lifeEvents: 'Life events',
  notes: 'Notes',
  reminders: 'Reminders',
  funFacts: 'Fun fact',
  inbox: 'AI app',
  callin: 'Call-in',
  opening: 'Opening',
  host: 'Banter',
};

/** Readable labels for a break's topic keys ('calendar:abc' -> 'Calendar'), deduped. */
export function topicLabels(topics: string[]): string[] {
  const seen = new Set<string>();
  for (const t of topics) {
    const base = t.split(':')[0]!;
    const label = TOPIC_LABELS[base];
    if (label) seen.add(label);
  }
  return [...seen];
}
