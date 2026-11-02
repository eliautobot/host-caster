// "What your hosts can see": every context source in plain words. Is it connected, which stations talk about it,
// what it holds right now (exactly what the hosts would get), when it was fetched and what went wrong last.
// Uses the same getters as the radio's context packet, so the preview cannot drift from what goes on air.
import { api } from '../api';
import { notion } from '../api/notion';
import { buildContext } from '../context/context';
import { cacheStatus, within, type CacheStatus } from '../context/cache';
import { activeNotes, dueLifeEvents, dueReminders } from '../context/life';
import { accountNews, deviceHints, feedName, newsRegion } from '../context/news';
import { NOTION_CONTEXT_KEY, getNotionPages } from '../context/notion';
import { feedsReachable, getCalendar, getEmail, getInbox, getNews, sourceKeys } from '../context/sources';
import { getWeather, weatherKey } from '../context/weather';
import { getProfile, getSettings, listStations } from '../db';
import { researchItems, type ResearchItem } from '../agent/brief';
import type { ContextPacket, SegmentKey, Station } from '../types';
import { noteKey, planBreak, type BreakPlan } from './planner';
import { emailSpoken, eventSpoken, weatherSpoken, whenSpoken } from './speakable';

export type SourceId = 'calendar' | 'email' | 'news' | 'weather' | 'reminders' | 'life' | 'notion' | 'aiApps';

export interface PreviewItem {
  text: string;
  detail?: string;
}

export interface SourceView {
  id: SourceId;
  title: string;
  connected: boolean;
  /** how it is connected, in plain words */
  how: string;
  /** names of the stations that talk about it, and of those that do not */
  on: string[];
  off: string[];
  /** what the hosts would get right now */
  preview: PreviewItem[];
  fetchedAt?: number;
  error?: string;
  /** one more plain sentence (reminders: only the next 3 hours air) */
  note?: string;
  /** where to set it up or change it */
  setup: { label: string; to: string };
}

export interface NextBreakView {
  station: string;
  rundown: boolean;
  /** what the next break would bring up, in order */
  items: string[];
}

/** What the research desk looks into from the same packet: the station it would research for, and the items. */
export interface DeskView {
  station: Station;
  items: ResearchItem[];
}

export interface HostsView {
  at: number;
  sources: SourceView[];
  next?: NextBreakView;
  desk?: DeskView;
}

const BUDGET_MS = 15_000;

function split(stations: Station[], ...segs: SegmentKey[]): { on: string[]; off: string[] } {
  const on = stations.filter((s) => segs.some((k) => s.segments[k])).map((s) => s.name);
  return { on, off: stations.filter((s) => !on.includes(s.name)).map((s) => s.name) };
}

/** The newest fetch time and the first error among a source's cache keys. */
async function statusOf(keys: string[], label: (key: string) => string = () => ''): Promise<{ fetchedAt?: number; error?: string }> {
  const all = await Promise.all(keys.map(async (k) => ({ k, s: await cacheStatus(k) })));
  const fetchedAt = Math.max(0, ...all.map(({ s }) => s.fetchedAt ?? 0)) || undefined;
  const bad = all.find(({ s }) => s.error) as { k: string; s: CacheStatus } | undefined;
  const name = bad && label(bad.k);
  return { fetchedAt, error: bad ? `${name ? `${name}: ` : ''}${plainError(bad.s.error!)}` : undefined };
}

/** Errors in words a listener understands. */
export function plainError(msg: string): string {
  if (msg === 'offline') return 'Needs you signed in and online.';
  if (/aborted|timeout|timed out/i.test(msg)) return 'It took too long to answer.';
  if (/HTTP (\d+)|answered (\d+)/i.test(msg)) return `The site said no (${/(\d{3})/.exec(msg)?.[1]}).`;
  return msg;
}

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

/** What a planned item is about, in a few words. */
function describe(plan: BreakPlan, packet: ContextPacket, now: number): string[] {
  const out: string[] = [];
  for (const i of plan.items) {
    const id = i.key.slice(i.key.indexOf(':') + 1);
    switch (i.segment) {
      case 'calendar': {
        const e = packet.calendar?.find((x) => x.id === id);
        if (e) out.push(eventSpoken(e, now));
        break;
      }
      case 'reminders': {
        const r = packet.reminders?.find((x) => x.id === id);
        if (r) out.push(`Reminder: ${r.text}`);
        break;
      }
      case 'email': {
        const m = packet.email?.find((x) => x.id === id);
        if (m) out.push(emailSpoken(m).replace(/^a/, 'A'));
        break;
      }
      case 'news': {
        const h = packet.news?.find((x) => x.id === i.key);
        if (h) out.push(`Headline: ${h.title}`);
        break;
      }
      case 'lifeEvents': {
        const e = packet.lifeEvents?.find((x) => x.id === id);
        if (e) out.push(e.title);
        break;
      }
      case 'notes': {
        const page = /^Your Notion page "(.*?)"/.exec(packet.notes?.find((n) => noteKey(n) === i.key) ?? '')?.[1];
        out.push(page ? `Your Notion page ${page}` : 'A note you left');
        break;
      }
      case 'inbox':
        out.push('A note from your AI app');
        break;
      case 'headsUp': {
        const h = packet.headsUps?.find((x) => `headsup:${x.id}` === i.key);
        if (h) out.push(`Heads-up: ${h.fact}`);
        break;
      }
      case 'weather':
        out.push('The weather');
        break;
      case 'time':
        out.push('The time');
        break;
      case 'funFacts':
        out.push('A fun fact');
        break;
      default:
        break;
    }
  }
  if (plan.intro && packet.songAfter) out.push(`Introduce the next song, ${packet.songAfter.title}`);
  return out;
}

export async function hostsView(opts: { fresh?: boolean; now?: number } = {}): Promise<HostsView> {
  const now = opts.now ?? Date.now();
  const fresh = { fresh: opts.fresh };
  const [settings, profile, stations] = await Promise.all([getSettings(), getProfile(), listStations()]);
  const conn = settings.connections;
  const online = api.available && api.signedIn;
  const sources: SourceView[] = [];

  // calendar
  {
    const c = conn.calendar;
    const links = c?.icsUrls?.length ?? 0;
    const connected = Boolean(c?.google || links);
    const events = connected ? ((await within(getCalendar(c, now, fresh), BUDGET_MS)) ?? []) : [];
    const ics = new Map((c?.icsUrls ?? []).map((u) => [`calendar:ics:${u}`, feedName(u)]));
    sources.push({
      id: 'calendar',
      title: 'Calendar',
      connected,
      how: connected ? list([...(c?.google ? ['Google Calendar'] : []), ...(links ? [`${links} calendar link${links === 1 ? '' : 's'}`] : [])]) : 'Not connected',
      ...split(stations, 'calendar'),
      preview: events.map((e) => ({ text: eventSpoken(e, now), detail: e.location })),
      ...(connected ? await statusOf(sourceKeys.calendar(c), (k) => (k === 'calendar:google' ? 'Google Calendar' : (ics.get(k) ?? ''))) : {}),
      note: connected ? 'The next 36 hours. The hosts bring up what is soonest first. Holiday and other calendars you only subscribe to are mentioned, never turned into to-dos.' : undefined,
      setup: { label: connected ? 'Change' : 'Connect', to: '/settings/connections' },
    });
  }

  // email
  {
    const e = conn.email;
    const connected = Boolean(e?.gmail || e?.imap);
    const mail = connected ? ((await within(getEmail(e, fresh), BUDGET_MS)) ?? []) : [];
    sources.push({
      id: 'email',
      title: 'Email',
      connected,
      how: connected ? list([...(e?.gmail ? ['Gmail'] : []), ...(e?.imap ? ['your mailbox (IMAP)'] : [])]).replace(/^y/, 'Y') : 'Not connected',
      ...split(stations, 'email'),
      preview: mail.map((m) => ({ text: emailSpoken(m).replace(/^a/, 'A'), detail: m.important ? 'Marked important' : undefined })),
      ...(connected ? await statusOf(sourceKeys.email(e), (k) => (k === 'email:gmail' ? 'Gmail' : 'Mailbox')) : {}),
      note: connected ? 'Unread mail: who wrote and what it is about. A message is read when it matters or when you ask on a call-in; links and addresses never are.' : undefined,
      setup: { label: connected ? 'Change' : 'Connect', to: '/settings/connections' },
    });
  }

  // news
  {
    const account = accountNews(conn.news, { place: profile.location, ...deviceHints() });
    // a web browser on its own cannot read the default feeds (no CORS): signed in, the server fetches them
    const blocked = !account.custom && !feedsReachable();
    const connected = account.enabled && account.feeds.length > 0 && !blocked;
    const heads = connected ? ((await within(getNews(account.feeds, fresh), BUDGET_MS)) ?? []) : [];
    const own = stations.filter((s) => s.segments.news && s.newsFeeds.length);
    sources.push({
      id: 'news',
      title: 'News',
      connected,
      how: !account.enabled
        ? 'Turned off'
        : account.custom
          ? `Your feeds: ${list(account.feeds.map(feedName))}`
          : `Top stories for ${newsRegion(account.region)?.label ?? 'World'}: ${list(account.feeds.map(feedName))}`,
      ...split(stations, 'news'),
      preview: heads.map((h) => ({ text: h.title, detail: h.source })),
      ...(connected ? await statusOf(account.feeds.slice(0, 6).map((u) => `news:${u}`), (k) => feedName(k.slice(5))) : {}),
      note: blocked
        ? 'A web browser cannot read news feeds by itself. Sign in and your Host-Caster server fetches the headlines for you (the phone apps read them directly).'
        : own.length
          ? `${list(own.map((s) => s.name))} ${own.length === 1 ? 'uses its' : 'use their'} own feeds.`
          : undefined,
      setup: blocked ? { label: 'Sign in', to: '/sign-in' } : { label: 'Change', to: '/settings/connections?show=news' },
    });
  }

  // weather
  {
    const place = profile.location;
    const on = conn.weather?.enabled !== false;
    const connected = Boolean(place) && on;
    const w = connected ? await within(getWeather(place!, profile.units), BUDGET_MS) : undefined;
    sources.push({
      id: 'weather',
      title: 'Weather',
      connected,
      how: !on ? 'Turned off' : place ? `${place.name || 'Your place'}, from Open-Meteo` : 'Add your town in About me',
      ...split(stations, 'weather'),
      preview: w ? [{ text: weatherSpoken(w) }] : [],
      ...(connected ? await statusOf([weatherKey(place!, profile.units)], () => 'Open-Meteo') : {}),
      setup: place ? { label: 'Change', to: '/settings/connections' } : { label: 'Add your town', to: '/settings/about-me' },
    });
  }

  // reminders
  {
    const due = dueReminders(profile.reminders, now);
    sources.push({
      id: 'reminders',
      title: 'Reminders',
      connected: true,
      how: `${profile.reminders.length} saved in About me`,
      ...split(stations, 'reminders'),
      preview: due.map((r) => ({ text: r.text, detail: whenSpoken(r.at, now) })),
      note: 'A reminder airs in the 3 hours before it is due.',
      setup: { label: 'Edit', to: '/settings/about-me' },
    });
  }

  // notes and life events
  {
    const events = dueLifeEvents(profile.lifeEvents, now);
    const notes = activeNotes(profile.notes, now);
    sources.push({
      id: 'life',
      title: 'Life events and notes',
      connected: true,
      how: `${profile.lifeEvents.length} life event${profile.lifeEvents.length === 1 ? '' : 's'} and ${profile.notes.length} note${profile.notes.length === 1 ? '' : 's'} in About me`,
      ...split(stations, 'lifeEvents', 'notes'),
      preview: [...events.map((i) => ({ text: i.event.title, detail: i.when })), ...notes.map((n) => ({ text: n, detail: 'Note' }))],
      note: 'Birthdays and anniversaries from a day before to a week ahead.',
      setup: { label: 'Edit', to: '/settings/about-me' },
    });
  }

  // Notion: the pages the listener picked, with the notes
  {
    const connected = Boolean(conn.notion?.connected) && online;
    const [status, pages] = connected
      ? await Promise.all([within(notion.status(), BUDGET_MS), within(getNotionPages(now, fresh), BUDGET_MS)])
      : [undefined, undefined];
    const read = status?.settings?.read ?? [];
    sources.push({
      id: 'notion',
      title: 'Notion',
      connected,
      how: !online
        ? 'Sign in to connect Notion'
        : !connected
          ? 'Not connected'
          : read.length
            ? `Your pages: ${list(read.map((r) => r.title))}`
            : 'Connected, no pages picked to read yet',
      ...split(stations, 'notes'),
      preview: (pages ?? []).map((p) => ({ text: p.text, detail: `${p.title}${p.edited ? `, edited ${p.edited}` : ''}` })),
      ...(connected ? await statusOf([NOTION_CONTEXT_KEY], () => 'Notion') : {}),
      note: connected ? 'Open to-dos, headings and recent changes from the pages you picked, with your notes.' : undefined,
      setup: online ? { label: connected ? 'Change' : 'Connect', to: '/settings/connections?show=notion' } : { label: 'Sign in', to: '/sign-in' },
    });
  }

  // AI apps
  {
    const enabled = conn.aiApps?.enabled !== false;
    const inbox = (await within(getInbox(enabled, now), BUDGET_MS)) ?? [];
    const items = inbox.filter((i) => i.kind !== 'song_request');
    sources.push({
      id: 'aiApps',
      title: 'AI apps',
      connected: enabled && online,
      how: !enabled ? 'Turned off' : online ? 'Notes and segments your AI apps send' : 'Sign in to connect ChatGPT, Claude and others',
      on: stations.map((s) => s.name),
      off: [],
      preview: items.map((i) => ({ text: i.text, detail: i.kind === 'segment' ? 'Segment to air' : 'Note' })),
      note: 'Each note airs once, in the next break.',
      setup: { label: online ? 'Manage' : 'Sign in', to: online ? '/settings/connections?show=ai-apps' : '/sign-in' },
    });
  }

  // the next break on the station that is playing (or the first one)
  let next: NextBreakView | undefined;
  let desk: DeskView | undefined;
  const station = stations.find((s) => s.id === settings.activeStationId) ?? stations[0];
  if (station) {
    const packet = await within(buildContext(station, {}, { now, budgetMs: 4000 }), BUDGET_MS);
    if (packet) {
      const plan = planBreak(station, packet, packet.recentBreaks, { now, kind: 'regular' });
      next = { station: station.name, rundown: Boolean(plan.rundown), items: describe(plan, packet, now) };
      desk = { station, items: researchItems(packet, now) };
    }
  }
  return { at: now, sources, next, desk };
}
