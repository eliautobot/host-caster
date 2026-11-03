// The lookups a host can make (read-only, except the existing Notion write which is not a lookup), where each runs:
// on the server where the data lives (Google, IMAP, Notion, linked pages, web search) or on this device (weather,
// calendar feeds). Which ones a task gets depends on what this account connected and on the listener's switches.
import { api, request } from '../api';
import { kvGet } from '../db';
import { parseIcs } from '../context/ics';
import { searchPlaces, weatherCondition } from '../context/weather';
import type { CalendarEvent, Connections, GeoPlace, Headline, ToolSpec, Units } from '../types';
import { DEVICE_LOOKUPS_PER_DAY, deviceLookupsToday, noteLookup } from './lookups';
import { journalSearch, memorySearch } from '../memory/search';
import { listSearch } from '../tracker/brief';

export type ToolName =
  | 'calendar_event'
  | 'calendar_search'
  | 'email_search'
  | 'email_read'
  | 'email_thread'
  | 'notion_search'
  | 'notion_read'
  | 'open_link'
  | 'news_article'
  | 'weather'
  | 'web_search'
  | 'memory_search'
  | 'journal_search'
  | 'my_list';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  calendar_event: {
    name: 'calendar_event',
    description: 'Full details of one calendar event by its id: what it is about, organizer, guests and who said yes, video call, attachments.',
    parameters: obj({ id: s('the event id from ITEMS') }, ['id']),
  },
  calendar_search: {
    name: 'calendar_search',
    description: "Find the listener's calendar events by words or a person's name, from 30 days back to 30 days ahead.",
    parameters: obj({ query: s('words or a name'), days_back: { type: 'number', description: '0 to 30, default 30' }, days_ahead: { type: 'number', description: '0 to 30, default 30' } }, ['query']),
  },
  email_search: {
    name: 'email_search',
    description: "Search the listener's email. Gmail words work: from:dana, subject:budget, newer_than:7d.",
    parameters: obj({ query: s('what to look for') }, ['query']),
  },
  email_read: {
    name: 'email_read',
    description: 'Read one email in full by its id.',
    parameters: obj({ id: s('the email id') }, ['id']),
  },
  email_thread: {
    name: 'email_thread',
    description: 'Read the whole conversation an email belongs to, by the email id.',
    parameters: obj({ id: s('the email id') }, ['id']),
  },
  notion_search: {
    name: 'notion_search',
    description: 'Search the Notion pages the listener shared with the hosts.',
    parameters: obj({ query: s('words to look for') }, ['query']),
  },
  notion_read: {
    name: 'notion_read',
    description: 'Read one of the shared Notion pages in full, by its id.',
    parameters: obj({ id: s('the Notion page id') }, ['id']),
  },
  open_link: {
    name: 'open_link',
    description: 'Read a web page linked from one of the items (an agenda, a shared document). Pages behind a sign-in cannot be read.',
    parameters: obj({ url: s('the http(s) link') }, ['url']),
  },
  news_article: {
    name: 'news_article',
    description: 'Read the full article behind a news headline, by the headline id from ITEMS.',
    parameters: obj({ id: s('the headline id') }, ['id']),
  },
  weather: {
    name: 'weather',
    description: "The forecast for a place (default the listener's town), today or a day in the next 7 days.",
    parameters: obj({ place: s('a town or city, optional'), day: s('YYYY-MM-DD, a weekday, "today" or "tomorrow"; optional') }),
  },
  memory_search: {
    name: 'memory_search',
    description: 'What you remember about the listener (things they told you, their plans, people, preferences, patterns), by words.',
    parameters: obj({ query: s('words to look for, e.g. "weekend", "sister", "job"') }, ['query']),
  },
  my_list: {
    name: 'my_list',
    description: "The listener's list (Your list): things to do, deadlines, bills, deliveries, invitations to answer, with due dates and where each came from. Read only.",
    parameters: obj({ query: s('words to look for, or "all"; optional'), status: s('"open" (default) or "done"') }),
  },
  journal_search: {
    name: 'journal_search',
    description: 'What happened on the radio in the last 14 days: what the listener said in call-ins, songs they liked, skipped or asked for, by words.',
    parameters: obj({ query: s('words to look for'), days: { type: 'number', description: '1 to 14, default 14' } }, ['query']),
  },
  web_search: {
    name: 'web_search',
    description: 'Search the web (for public facts the items do not have: a company, a place, a news story).',
    parameters: obj({ query: s('the search words') }, ['query']),
  },
};

// ---- what this account can use -------------------------------------------------------------------------------------

export interface ServerAgentStatus {
  tools: { calendar: boolean; gmail: boolean; imap: boolean; notion: boolean; web: boolean; webProvider?: string; links: boolean; notionLinked?: boolean; notionWrite?: boolean };
  caps: { lookupsPerDay: number; webSearchesPerDay: number };
  used: { lookups: number; webSearches: number };
}

let statusCache: { at: number; value?: ServerAgentStatus } = { at: 0 };

/** The server's view (cached 5 minutes, or `maxAgeMs`); undefined when signed out or unreachable. */
export async function serverStatus(fresh = false, maxAgeMs = 5 * 60_000): Promise<ServerAgentStatus | undefined> {
  if (!api.available || !api.signedIn) return undefined;
  if (!fresh && Date.now() - statusCache.at < maxAgeMs) return statusCache.value;
  try {
    const value = await request<ServerAgentStatus>('GET', '/api/agent/status', undefined, { timeoutMs: 8000 });
    statusCache = { at: Date.now(), value };
    return value;
  } catch {
    statusCache = { at: Date.now() - 4 * 60_000, value: statusCache.value };
    return statusCache.value;
  }
}

export function forgetServerStatus(): void {
  statusCache = { at: 0 };
}

export interface ToolContext {
  connections: Connections;
  place?: GeoPlace;
  units: Units;
  /** headlines the hosts know (news_article ids) */
  headlines: Headline[];
  /** who is looking (the Lookups log) */
  host?: string;
  purpose: 'research' | 'call-in' | 'question';
}

/** The tools a task may offer the model. */
export async function availableTools(ctx: Pick<ToolContext, 'connections' | 'headlines'>): Promise<ToolName[]> {
  const st = await serverStatus();
  const t = st?.tools;
  const ics = (ctx.connections.calendar?.icsUrls?.length ?? 0) > 0;
  const out: ToolName[] = [];
  if (t?.calendar || ics) out.push('calendar_event', 'calendar_search');
  if (t?.gmail || t?.imap) out.push('email_search', 'email_read', 'email_thread');
  if (t?.notion) out.push('notion_search', 'notion_read');
  if (t?.links) {
    out.push('open_link');
    if (ctx.headlines.length) out.push('news_article');
  }
  out.push('weather', 'memory_search', 'journal_search', 'my_list');
  if (t?.web && ctx.connections.lookups?.web !== false) out.push('web_search');
  return out;
}

// ---- running a lookup -----------------------------------------------------------------------------------------------

export interface ToolOutcome {
  ok: boolean;
  /** what goes back to the model (JSON text, capped) */
  content: string;
  /** a few words for the Lookups log and the dossier's sources */
  what: string;
}

const MAX_RESULT = 3500;
const asText = (v: unknown) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}...(cut)` : t;
};

async function icsTexts(conn: Connections): Promise<string[]> {
  const out: string[] = [];
  for (const url of conn.calendar?.icsUrls ?? []) {
    const row = await kvGet<string>(`calendar:ics:${url}`);
    if (typeof row?.value === 'string') out.push(row.value);
  }
  return out;
}

const DAY = 86_400_000;

const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** A time as the listener says it ("Sunday, November 1, 12:15 PM"): models misread UTC times. */
export const localWhen = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const eventOut = (e: CalendarEvent) => ({
  id: e.id,
  title: e.title,
  start: localWhen(e.start),
  ...(e.end ? { end: localWhen(e.end) } : {}),
  ...(e.allDay ? { allDay: true } : {}),
  ...(e.location ? { location: e.location } : {}),
  ...(e.description ? { description: e.description } : {}),
  ...(e.organizer ? { organizer: e.organizer } : {}),
  ...(e.attendees?.length ? { attendees: e.attendees } : {}),
  ...(e.recurrence ? { recurrence: e.recurrence } : {}),
  ...(e.video ? { video: e.video.provider } : {}),
});

/** Calendar feeds (ICS) on the device: one event, or events matching words, 30 days back and ahead. */
async function icsLookup(conn: Connections, name: 'calendar_event' | 'calendar_search', args: Record<string, unknown>): Promise<{ events: ReturnType<typeof eventOut>[] }> {
  const now = Date.now();
  const all = (await icsTexts(conn)).flatMap((t) => parseIcs(t, now - 30 * DAY, now + 30 * DAY));
  if (name === 'calendar_event') return { events: all.filter((e) => e.id === args.id).slice(0, 1).map(eventOut) };
  const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const hay = (e: CalendarEvent) => [e.title, e.description, e.location, e.organizer, ...(e.attendees ?? []).map((a) => a.name)].join(' ').toLowerCase();
  return { events: all.filter((e) => words.some((w) => hay(e).includes(w))).slice(0, 10).map(eventOut) };
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "tomorrow", "friday", "2026-11-03" -> days from today (0..6), or undefined. */
export function dayOffset(day: unknown, now = new Date()): number | undefined {
  const d = String(day ?? '').trim().toLowerCase();
  if (!d || d === 'today' || d === 'now') return 0;
  if (d === 'tomorrow') return 1;
  const wd = DAYS.indexOf(d);
  if (wd >= 0) return (wd - now.getDay() + 7) % 7;
  const at = Date.parse(`${d}T12:00:00`);
  if (!Number.isFinite(at)) return undefined;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
  const n = Math.round((at - today) / DAY);
  return n >= 0 && n <= 6 ? n : undefined;
}

async function weatherLookup(ctx: ToolContext, args: Record<string, unknown>): Promise<{ result: unknown; what: string }> {
  let place = ctx.place;
  if (args.place && String(args.place).trim()) place = (await searchPlaces(String(args.place).slice(0, 80)))[0] ?? place;
  if (!place) return { result: { error: 'No town is set in About me, and none was given.' }, what: 'Weather (no place)' };
  const offset = dayOffset(args.day) ?? 0;
  const q = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  if (ctx.units === 'imperial') {
    q.set('temperature_unit', 'fahrenheit');
    q.set('wind_speed_unit', 'mph');
  }
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`The weather service answered ${res.status}`);
  const j = (await res.json()) as { daily?: Record<string, (number | string)[]> };
  const d = j.daily ?? {};
  const pick = (k: string) => d[k]?.[offset];
  const result = {
    place: place.name,
    date: pick('time'),
    condition: weatherCondition(Number(pick('weather_code'))),
    high: pick('temperature_2m_max'),
    low: pick('temperature_2m_min'),
    rainChancePercent: pick('precipitation_probability_max'),
    windMax: pick('wind_speed_10m_max'),
    units: ctx.units === 'imperial' ? 'F, mph' : 'C, km/h',
  };
  return { result, what: `Weather: ${place.name}, ${offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : String(pick('time'))}` };
}

async function serverLookup(name: ToolName, args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<{ result: unknown; what: string }> {
  return request<{ result: unknown; what: string }>('POST', '/api/agent/tool', { name, args, host: ctx.host, purpose: ctx.purpose, tz: localZone() }, { timeoutMs: 30_000, signal });
}

/** Runs one lookup and logs it. Never throws: a failure is an answer the model can work with. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<ToolOutcome> {
  const t0 = Date.now();
  const tool = name as ToolName;
  if (!(tool in TOOL_SPECS)) return { ok: false, content: asText({ error: `There is no lookup called ${name}.` }), what: name };
  // signed out, nothing else counts this device's lookups: its own daily cap
  if (!(api.available && api.signedIn) && (await deviceLookupsToday()) >= DEVICE_LOOKUPS_PER_DAY) {
    return { ok: false, content: asText({ error: 'No more lookups today: answer with what you have.' }), what: `${name.replace(/_/g, ' ')} (daily limit)` };
  }
  try {
    let out: { result: unknown; what: string };
    let device = false;
    if (tool === 'weather') {
      out = await weatherLookup(ctx, args);
      device = true;
    } else if (tool === 'memory_search') {
      const r = await memorySearch(String(args.query ?? ''));
      out = { result: r, what: `Memory: "${String(args.query ?? '').slice(0, 40)}" (${r.cards.length} found)` };
      device = true;
    } else if (tool === 'my_list') {
      const r = await listSearch(String(args.query ?? ''), args.status === 'done' ? 'done' : 'open');
      out = { result: r, what: `Your list: "${String(args.query ?? 'all').slice(0, 40)}" (${r.items.length} found)` };
      device = true;
    } else if (tool === 'journal_search') {
      const r = await journalSearch(String(args.query ?? ''), Number(args.days ?? 14) || 14);
      out = { result: r, what: `Recently: "${String(args.query ?? '').slice(0, 40)}" (${r.rows.length} found)` };
      device = true;
    } else if ((tool === 'calendar_event' && String(args.id ?? '').startsWith('ics:')) || (tool === 'calendar_search' && !(await serverStatus())?.tools.calendar)) {
      const r = await icsLookup(ctx.connections, tool, args);
      out = { result: r, what: tool === 'calendar_event' ? `Calendar event: ${r.events[0]?.title ?? 'not found'}` : `Calendar search: "${String(args.query ?? '').slice(0, 40)}" (${r.events.length} found)` };
      device = true;
    } else if (tool === 'calendar_search') {
      const r = await serverLookup(tool, args, ctx, signal);
      const feeds = (ctx.connections.calendar?.icsUrls?.length ?? 0) > 0 ? (await icsLookup(ctx.connections, tool, args)).events : [];
      const events = [...((r.result as { events?: unknown[] }).events ?? []), ...feeds];
      out = { result: { events }, what: r.what };
    } else if (tool === 'news_article') {
      const h = ctx.headlines.find((x) => x.id === args.id || x.title === args.id);
      if (!h?.url) return { ok: false, content: asText({ error: 'That headline has no article link.' }), what: 'News article (no link)' };
      out = await serverLookup('news_article', { url: h.url }, ctx, signal);
    } else {
      out = await serverLookup(tool, args, ctx, signal);
    }
    // the server logs its own lookups; this device's list keeps them all, and reports only the ones it ran itself
    noteLookup({ tool, what: out.what, host: ctx.host, purpose: ctx.purpose, ok: true, ms: Date.now() - t0 }, { report: device });
    return { ok: true, content: asText(out.result), what: out.what };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const what = `${name.replace(/_/g, ' ')} (did not work)`;
    noteLookup({ tool, what, host: ctx.host, purpose: ctx.purpose, ok: false, ms: Date.now() - t0 }, { report: tool === 'weather' });
    return { ok: false, content: asText({ error: msg.slice(0, 200) }), what };
  }
}
