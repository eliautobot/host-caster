// Topic mix measurement with a real model (skipped unless HC_MEASURE=1): plays a morning of breaks for a station whose
// packet holds calendar events, reminders, email, news and weather, and counts the lines about the songs and about the
// listener's day. HC_MEASURE_ROOT points at another copy of app/src (an older version) to compare.
//   HC_MEASURE=1 HC_MEASURE_OUT=/tmp/mix.json npx vitest run src/core/radio/topicmix.measure.test.ts
// Env: HC_MEASURE_BASE (OpenAI-compatible URL), HC_MEASURE_MODEL, HC_MEASURE_BREAKS (24), HC_MEASURE_ROOT,
// HC_MEASURE_RECENT (breaks the planner sees, as that version's context loads them), HC_MEASURE_NEWS=0 (no headlines
// reach the packet, as in versions where a station without feeds of its own had no news).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Brain, Break, BreakLine, ContextPacket, Headline, Host, Station } from '../types';

const ON = process.env.HC_MEASURE === '1';
const ROOT = process.env.HC_MEASURE_ROOT || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const BASE = process.env.HC_MEASURE_BASE || 'http://localhost:11434/v1';
const MODEL = process.env.HC_MEASURE_MODEL || 'gemma3:4b-it-qat';
const BREAKS = Number(process.env.HC_MEASURE_BREAKS || 24);
const RECENT = Number(process.env.HC_MEASURE_RECENT || 60);
const NEWS = process.env.HC_MEASURE_NEWS !== '0';
const MIN = 60_000;

const SONGS = [
  ['Dreams', 'Fleetwood Mac'], ['Midnight City', 'M83'], ['Electric Feel', 'MGMT'], ['Harvest Moon', 'Neil Young'],
  ['Heat Waves', 'Glass Animals'], ['Feel It Still', 'Portugal. The Man'], ['Holocene', 'Bon Iver'], ['Valerie', 'Amy Winehouse'],
  ['Little Talks', 'Of Monsters and Men'], ['Riptide', 'Vance Joy'], ['Ho Hey', 'The Lumineers'], ['Budapest', 'George Ezra'],
  ['Sunday Morning', 'Maroon 5'], ['Stolen Dance', 'Milky Chance'], ['Tongue Tied', 'Grouplove'], ['Pumped Up Kicks', 'Foster the People'],
  ['Young Folks', 'Peter Bjorn and John'], ['Float On', 'Modest Mouse'], ['Do I Wanna Know?', 'Arctic Monkeys'], ['Take On Me', 'a-ha'],
  ['Mr. Brightside', 'The Killers'], ['Sweater Weather', 'The Neighbourhood'], ['Shut Up and Dance', 'Walk the Moon'], ['Ophelia', 'The Lumineers'],
  ['Home', 'Edward Sharpe and the Magnetic Zeros'], ['Rivers and Roads', 'The Head and the Heart'],
].map(([title, artist], i) => ({ id: `s${i}`, title: title!, artist: artist!, album: '', durationMs: 220_000, source: 'local' as const }));

const FALLBACK_NEWS: Headline[] = [
  'City council approves new bike lanes downtown',
  'Storm system expected to bring heavy rain to the Midwest',
  'Scientists map the deepest part of the Atlantic',
  'Local library extends weekend hours',
  'Rail strike talks resume after a week of delays',
  'Researchers find a new way to recycle solar panels',
  'National park visits hit a record high this year',
  'Tech firms agree on a common standard for phone chargers',
].map((title, i) => ({ id: `news:f${i}`, title, source: 'NPR News' }));

/** Headlines from the US default feeds, interleaved (the packet shows 10 at a time, one new one per break). */
async function liveNews(parseFeed: (xml: string, src: string) => Headline[]): Promise<Headline[]> {
  const feeds = [
    ['https://feeds.npr.org/1001/rss.xml', 'NPR News'],
    ['https://www.pbs.org/newshour/feeds/rss/headlines', 'PBS NewsHour'],
    ['https://www.cbsnews.com/latest/rss/main', 'CBS News'],
  ] as const;
  const lists = await Promise.all(
    feeds.map(async ([url, name]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        return parseFeed(await res.text(), name).slice(0, 15).map((h) => ({ ...h, source: name }));
      } catch {
        return [];
      }
    }),
  );
  const out: Headline[] = [];
  for (let i = 0; i < 15; i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out.length >= 12 ? out : FALLBACK_NEWS;
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
// generic words, numbers and days say nothing about which item a line is about
const STOP = new Set(
  ('the and for with from your this that have about into after over will just more than what when then their there they them were been being some here near today tomorrow morning ' +
    'call send pick team place spot moved check game lines nine eight seven three four five twelve eleven twenty thirty forty fifty ' +
    'monday tuesday wednesday thursday friday saturday sunday').split(' '),
);
const keywords = (s: string) => norm(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w));

/** What a line talks about: the songs, the listener's day (by item), weather/time. */
function classify(text: string, p: ContextPacket) {
  const t = ` ${norm(text)} `;
  const has = (w: string) => t.includes(` ${w} `) || t.includes(` ${w}s `) || t.includes(` ${w}'s `);
  const songNames = [p.songBefore, p.songAfter].filter(Boolean).flatMap((s) => [norm(s!.title), norm(s!.artist)]).filter((x) => x.length >= 3);
  const song = songNames.some((n) => t.includes(` ${n} `) || t.includes(` ${n}`)) || /\b(track|tune|song|next up|coming up next|that was)\b/.test(t);
  const day: string[] = [];
  for (const e of p.calendar ?? []) if (keywords(e.title).some(has)) day.push('calendar');
  for (const r of p.reminders ?? []) if (keywords(r.text).filter(has).length >= 1) day.push('reminders');
  for (const m of p.email ?? []) {
    const sender = keywords(m.from.replace(/<.*>/, '')).some(has);
    if (sender || keywords(m.subject).filter(has).length >= 2 || /\b(email|e mail|inbox|message from|mail from)\b/.test(t)) day.push('email');
  }
  for (const h of p.news ?? []) if (keywords(h.title).filter(has).length >= 2 || /\b(headline|news)\b/.test(t)) day.push('news');
  for (const e of p.lifeEvents ?? []) if (keywords(e.title).some(has)) day.push('lifeEvents');
  for (const n of p.notes ?? []) if (keywords(n).filter(has).length >= 2) day.push('notes');
  const weather = /\b(degrees|rain|rainy|sunny|cloud|cloudy|forecast|weather|umbrella|drizzle|showers)\b/.test(t);
  const time = /\b(o'clock|half past|quarter (past|to)|it's (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/.test(t);
  return { song, day: [...new Set(day)], weather, time };
}

interface Item {
  key: string;
  words: string[];
  /** after this the item is over (an event that ended, a reminder an hour late) */
  over?: number;
}

/** Items a line names, by the words only that item has (calendar:<id>, reminders:<id>, email:<id>, lifeEvents:<id>). */
function itemsNamed(text: string, items: Item[]): string[] {
  const t = ` ${norm(text)} `;
  const has = (w: string) => t.includes(` ${w} `) || t.includes(` ${w}s `) || t.includes(` ${w}'s `);
  const count = new Map<string, number>();
  for (const i of items) for (const w of new Set(i.words)) count.set(w, (count.get(w) ?? 0) + 1);
  return items.filter((i) => i.words.filter((w) => count.get(w) === 1).some(has)).map((i) => i.key);
}

describe.skipIf(!ON)('topic mix with a real model', () => {
  it(`plays ${BREAKS} breaks on ${MODEL}`, { timeout: 60 * 60_000 }, async () => {
    const planner = await import(/* @vite-ignore */ `${ROOT}/core/radio/planner.ts`);
    const writer = await import(/* @vite-ignore */ `${ROOT}/core/radio/writer.ts`);
    const defaults = await import(/* @vite-ignore */ `${ROOT}/core/db/defaults.ts`);
    const rss = await import(/* @vite-ignore */ `${ROOT}/core/context/rss.ts`);
    const life = await import(/* @vite-ignore */ `${ROOT}/core/context/life.ts`);

    const day0 = new Date();
    day0.setHours(0, 0, 0, 0);
    const at = (h: number, m: number, plusDays = 0) => day0.getTime() + plusDays * 86_400_000 + (h * 60 + m) * MIN;
    const start = at(9, 20);
    const brain: Brain = { id: 'measure', createdAt: 0, updatedAt: 0, name: 'Measure', kind: 'openai', baseUrl: BASE, model: MODEL, transport: 'device', temperature: 0.8 };
    const hosts: Host[] = defaults.STARTER_HOSTS.slice(0, 2).map((h: Omit<Host, 'createdAt' | 'updatedAt'>) => ({ ...h, createdAt: 0, updatedAt: 0, brainId: brain.id }));
    // what a new station looks like in that version (its defaults decide email and the talk mix)
    const station: Station = { ...defaults.STARTER_STATION, createdAt: 0, updatedAt: 0, segments: defaults.defaultSegments() };
    const news = await liveNews(rss.parseFeed);
    const tomorrow = new Date(at(0, 0, 1));
    const calendarAll = [
      { id: 'standup', title: 'Team stand-up', start: at(10, 0), end: at(10, 15), allDay: false, source: 'ics' as const },
      { id: 'dentist', title: 'Dentist appointment', start: at(11, 30), end: at(12, 15), allDay: false, source: 'ics' as const, location: 'Main Street Dental' },
      { id: 'lunch', title: 'Lunch with Priya', start: at(12, 45), end: at(13, 45), allDay: false, source: 'ics' as const },
      { id: 'soccer', title: 'Pick up Leo from soccer practice', start: at(17, 30), end: at(18, 0), allDay: false, source: 'ics' as const },
      { id: 'flight', title: 'Flight to Denver', start: at(8, 5, 1), end: at(10, 30, 1), allDay: false, source: 'ics' as const },
    ];
    const reminders = [
      { id: 'pharmacy', text: 'Call the pharmacy about the refill', at: at(10, 45) },
      { id: 'rent', text: 'Send the rent transfer', at: at(12, 0) },
    ];
    const lifeEvents = [{ id: 'mom', title: "Mom's birthday", date: `1961-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`, yearly: true }];

    const recent: Break[] = [];
    const emails = [
      { id: 'priya', from: 'Priya Shah <priya@example.com>', subject: 'Lunch spot moved to the Thai place', important: true },
      { id: 'delta', from: 'Delta Air Lines <noreply@example.com>', subject: 'Your flight to Denver: check in now', important: true },
      { id: 'coach', from: 'Coach Mike <mike@example.com>', subject: 'Saturday game moved to nine', important: false },
    ];
    // every item of the morning, to catch a line that names one this break's FACTS did not hold (copied from an
    // earlier break, often with a time that is out of date)
    const everything: Item[] = [
      ...calendarAll.map((e) => ({ key: `calendar:${e.id}`, words: keywords(e.title), over: e.end })),
      ...reminders.map((r) => ({ key: `reminders:${r.id}`, words: keywords(r.text), over: r.at + 60 * MIN })),
      ...emails.map((m) => ({ key: `email:${m.id}`, words: [...keywords(m.from.replace(/<.*>/, '')), ...keywords(m.subject)] })),
      ...lifeEvents.map((e) => ({ key: `lifeEvents:${e.id}`, words: keywords(e.title) })),
    ];
    type Line = { text: string; song: boolean; day: string[]; weather: boolean; time: boolean; unplanned: string[]; stale: string[] };
    const rows: { at: string; kind: string; plan: string[]; rundown: boolean; outro: boolean; lines: Line[]; introOk: boolean; error?: string }[] = [];
    for (let i = 0; i < BREAKS; i++) {
      const now = start + i * 8 * MIN;
      const songBefore = SONGS[(2 * i) % SONGS.length]!;
      const songAfter = SONGS[(2 * i + 1) % SONGS.length]!;
      const d = new Date(now);
      const packet: ContextPacket = {
        now: { iso: d.toISOString(), local: d.toString(), partOfDay: d.getHours() < 12 ? 'morning' : 'afternoon', weekday: d.toLocaleDateString('en-US', { weekday: 'long' }) },
        listener: { name: 'Sam Rivera', callMe: 'Sam', about: 'Product designer with two kids', interests: ['running', 'cooking'], avoid: [] },
        songBefore,
        songAfter,
        upcomingSongs: [],
        weather: { place: 'Chicago', temperature: 54, feelsLike: 51, condition: 'light rain', high: 58, low: 47, precipitationChance: 70, units: 'imperial', fetchedAt: now },
        calendar: calendarAll.filter((e) => e.end > now && e.start < now + 36 * 3600_000),
        email: emails.map((m, k) => ({ ...m, at: now - (k + 1) * 45 * MIN })),
        // feeds keep publishing: the packet's ten newest move on by one headline per break
        news: NEWS ? news.slice(i % Math.max(1, news.length - 9), (i % Math.max(1, news.length - 9)) + 10) : undefined,
        lifeEvents: life.dueLifeEvents(lifeEvents, now).map((x: { event: unknown }) => x.event),
        notes: ['Try to drink more water today'],
        reminders: life.dueReminders(reminders, now),
        recentBreaks: recent.slice(0, RECENT),
      };
      const plan = planner.planBreak(station, packet, packet.recentBreaks, { kind: i === 0 ? 'opening' : 'regular', now, hostCount: 2 });
      let lines: BreakLine[] = [];
      let error: string | undefined;
      for (let attempt = 0; attempt < 2 && !lines.length; attempt++) {
        try {
          lines = (await writer.writeBreak({ station, hosts, brains: new Map([[brain.id, brain]]), plan, packet, timeoutMs: 120_000 })).lines;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
      const planned = new Set<string>(plan.items.map((x: { key: string }) => x.key));
      // a planned calendar item brings up to two more events along ("also on the calendar")
      const calOk = plan.items.some((x: { segment: string }) => x.segment === 'calendar');
      const cls: Line[] = lines.map((l) => {
        const named = itemsNamed(l.text, everything);
        const unplanned = named.filter((k) => !planned.has(k) && !(calOk && k.startsWith('calendar:')));
        const stale = named.filter((k) => (everything.find((x) => x.key === k)?.over ?? Infinity) < now);
        return { text: l.text, ...classify(l.text, packet), unplanned, stale };
      });
      const all = norm(lines.map((l) => l.text).join(' '));
      rows.push({
        at: d.toTimeString().slice(0, 5),
        kind: plan.kind,
        plan: plan.items.map((x: { key: string }) => x.key),
        rundown: Boolean(plan.rundown),
        outro: plan.outro,
        lines: cls,
        introOk: all.includes(norm(songAfter.title)),
        ...(lines.length ? {} : { error }),
      });
      recent.unshift({ id: `b${i}`, createdAt: now, updatedAt: now, stationId: station.id, at: now, lines, topics: planner.planTopicKeys(plan), songBefore, songAfter });
      console.log(`[measure] ${rows.at(-1)!.at} ${plan.kind}${plan.rundown ? ' rundown' : ''} plan=${rows.at(-1)!.plan.join(',')} lines=${lines.length}${error && !lines.length ? ` ERROR ${error}` : ''}`);
    }

    const aired = rows.filter((r) => r.lines.length);
    const lines = aired.flatMap((r) => r.lines);
    const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
    const summary = {
      root: ROOT,
      model: MODEL,
      recent: RECENT,
      news: NEWS,
      breaks: rows.length,
      aired: aired.length,
      lines: lines.length,
      linesAboutSongs: pct(lines.filter((l) => l.song).length, lines.length),
      linesAboutDay: pct(lines.filter((l) => l.day.length).length, lines.length),
      linesWeatherOrTime: pct(lines.filter((l) => l.weather || l.time).length, lines.length),
      breaksMentioningDay: pct(aired.filter((r) => r.lines.some((l) => l.day.length)).length, aired.length),
      breaksIntroducingNext: pct(aired.filter((r) => r.introOk).length, aired.length),
      breaksBackAnnouncing: pct(aired.filter((r) => r.outro).length, aired.length),
      linesNamingItemsNotInFacts: pct(lines.filter((l) => l.unplanned.length).length, lines.length),
      linesNamingItemsAlreadyOver: pct(lines.filter((l) => l.stale.length).length, lines.length),
      daySources: Object.fromEntries(['calendar', 'reminders', 'email', 'news', 'lifeEvents', 'notes'].map((k) => [k, aired.filter((r) => r.lines.some((l) => l.day.includes(k))).length])),
    };
    console.log('[measure] SUMMARY', JSON.stringify(summary));
    if (process.env.HC_MEASURE_OUT) writeFileSync(process.env.HC_MEASURE_OUT, JSON.stringify({ summary, rows }, null, 2));
    expect(aired.length).toBeGreaterThan(0);
  });
});
