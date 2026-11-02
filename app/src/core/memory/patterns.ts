// Patterns from how the listener listens (pure, no brain needed): a pattern needs real evidence, at least 3 times
// over at least 2 days in the journal, and its card says how often it was seen ("Skips the news before 9 AM",
// "Likes songs by Test Band"). Each rule has a key, so the daily reflection updates the same card.
import type { JournalEntry, MemoryKind } from '../types';

export const MIN_TIMES = 3;
export const MIN_DAYS = 2;

export interface PatternDraft {
  pattern: string;
  kind: MemoryKind;
  text: string;
  evidence: { count: number; days: number };
}

export type Bucket = 'early' | 'morning' | 'afternoon' | 'evening' | 'night';
export const BUCKET_WORDS: Record<Bucket, string> = {
  early: 'before 9 AM',
  morning: 'in the late morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
  night: 'late at night',
};

export function bucketOf(ms: number): Bucket {
  const h = new Date(ms).getHours();
  if (h < 9 && h >= 4) return 'early';
  if (h < 4 || h >= 22) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const SEGMENT_WORDS: Record<string, string> = {
  news: 'the news',
  weather: 'the weather',
  calendar: 'calendar talk',
  email: 'email talk',
  funFacts: 'fun facts',
  notes: 'your notes',
  reminders: 'reminders',
  lifeEvents: 'life events',
  inbox: 'AI app notes',
};

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

interface Tally {
  count: number;
  days: Set<string>;
}
const tally = (m: Map<string, Tally>, key: string, day: string) => {
  const t = m.get(key) ?? { count: 0, days: new Set<string>() };
  t.count++;
  t.days.add(day);
  m.set(key, t);
};
const strong = (t: Tally | undefined) => Boolean(t && t.count >= MIN_TIMES && t.days.size >= MIN_DAYS);
const ev = (t: Tally) => ({ count: t.count, days: t.days.size });

/** Every pattern the journal shows with enough evidence. */
export function findPatterns(rows: JournalEntry[]): PatternDraft[] {
  const out: PatternDraft[] = [];
  // breaks skipped by segment and time of day, against the breaks with that segment they heard out
  const skipped = new Map<string, Tally>();
  const heard = new Map<string, Tally>();
  const songsSkipped = new Map<string, Tally>();
  const liked = new Map<string, Tally>();
  const genres = new Map<string, Tally>();
  const genreDays = new Map<string, Tally>();
  const listenDays = new Map<string, Tally>();
  const stationIn = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const b = bucketOf(r.at);
    if (r.kind === 'breakSkipped' || r.kind === 'covered') {
      for (const s of r.segments ?? []) tally(r.kind === 'breakSkipped' ? skipped : heard, `${s}:${b}`, r.day);
    } else if (r.kind === 'skipped' && r.artist) {
      tally(songsSkipped, r.artist.toLowerCase(), r.day);
      names.set(r.artist.toLowerCase(), r.artist);
    } else if ((r.kind === 'liked' || r.kind === 'requested') && (r.artist || r.genre)) {
      if (r.artist) {
        tally(liked, r.artist.toLowerCase(), r.day);
        names.set(r.artist.toLowerCase(), r.artist);
      }
      if (r.genre) {
        const g = r.genre.toLowerCase();
        tally(genres, g, r.day);
        tally(genreDays, `${g}:${new Date(r.at).getDay()}`, r.day);
        names.set(g, r.genre);
      }
    } else if (r.kind === 'listened') {
      // one per day per time of day (the journal has one row per hour)
      const key = `${b}`;
      const t = listenDays.get(key) ?? { count: 0, days: new Set<string>() };
      if (!t.days.has(r.day)) t.count++;
      t.days.add(r.day);
      listenDays.set(key, t);
      if (r.stationId) {
        const m = stationIn.get(key) ?? new Map<string, number>();
        m.set(r.text, (m.get(r.text) ?? 0) + 1);
        stationIn.set(key, m);
      }
    }
  }
  for (const [key, t] of skipped) {
    if (!strong(t)) continue;
    const [seg, b] = key.split(':') as [string, Bucket];
    const heardOut = heard.get(key)?.count ?? 0;
    // mostly skipped, not now and then
    if (t.count / (t.count + heardOut) < 0.6) continue;
    out.push({ pattern: `skip-seg:${seg}:${b}`, kind: 'routines', text: `Skips ${SEGMENT_WORDS[seg] ?? seg} ${BUCKET_WORDS[b]}`, evidence: ev(t) });
  }
  for (const [a, t] of songsSkipped) {
    const likedToo = liked.get(a)?.count ?? 0;
    if (strong(t) && likedToo < t.count) out.push({ pattern: `skip-artist:${a}`, kind: 'preferences', text: `Often skips songs by ${names.get(a)}`, evidence: ev(t) });
  }
  for (const [a, t] of liked) {
    const skips = songsSkipped.get(a)?.count ?? 0;
    if (strong(t) && skips < t.count) out.push({ pattern: `like-artist:${a}`, kind: 'preferences', text: `Likes songs by ${names.get(a)}`, evidence: ev(t) });
  }
  for (const [g, t] of genres) {
    if (!strong(t)) continue;
    // mostly on one weekday: "Likes 90s rock on Fridays"
    const day = [...genreDays].filter(([k]) => k.startsWith(`${g}:`)).sort((x, y) => y[1].count - x[1].count)[0];
    const onDay = day && strong(day[1]) && day[1].count / t.count >= 0.75 ? Number(day[0].split(':').pop()) : undefined;
    out.push({
      pattern: `like-genre:${g}`,
      kind: 'preferences',
      text: `Likes ${names.get(g)}${onDay !== undefined ? ` on ${WEEKDAYS[onDay]}` : ''}`,
      evidence: ev(onDay !== undefined ? day![1] : t),
    });
  }
  for (const [b, t] of listenDays) {
    if (t.days.size < MIN_TIMES) continue;
    const top = [...(stationIn.get(b) ?? new Map<string, number>())].sort((x, y) => y[1] - x[1])[0];
    const all = [...(stationIn.get(b)?.values() ?? [])].reduce((s, n) => s + n, 0);
    const station = top && top[1] / Math.max(1, all) >= 0.75 ? top[0].replace(/^Listened to /, '').replace(/ around .*$/, '') : undefined;
    out.push({
      pattern: `listen:${b}`,
      kind: 'routines',
      text: `Usually listens${station ? ` to ${station}` : ''} ${BUCKET_WORDS[b as Bucket]}`,
      evidence: { count: t.count, days: t.days.size },
    });
  }
  return out;
}

/** Segments to play down now, from the "Skips ... " pattern keys. */
export function quieterFrom(patterns: (string | undefined)[], now: number): string[] {
  const b = bucketOf(now);
  return [...new Set(patterns.flatMap((p) => (p?.startsWith('skip-seg:') && p.endsWith(`:${b}`) ? [p.split(':')[1]!] : [])))];
}
