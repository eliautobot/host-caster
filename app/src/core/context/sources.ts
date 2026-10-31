// Calendar, email, news and AI-app inbox sources. Each caches in kv and returns the last snapshot when offline.
import { api, inbox as inboxApi, integrations, request } from '../api';
import { kvGet, kvSet } from '../db';
import { isNative } from '../native';
import type { CalendarEvent, Connections, EmailSummary, Headline, InboxItem } from '../types';
import { cached } from './cache';
import { parseIcs } from './ics';
import { parseFeed } from './rss';

/** ICS/RSS text: direct on native (no CORS), through the server on web when signed in, else direct. */
export async function fetchText(url: string): Promise<string> {
  const online = api.available && api.signedIn;
  if (!isNative && online) return (await integrations.fetchText(url)).text;
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  } catch (err) {
    // most feeds send no CORS headers, so a browser cannot read them directly
    if (!isNative && err instanceof TypeError) throw new Error(`${host} does not let web apps read it directly. Sign in so your Host-Caster server can fetch it for you.`);
    throw err;
  }
  if (!res.ok) throw new Error(`${host} answered ${res.status}`);
  return res.text();
}

const HOURS = 36;

export async function getCalendar(conn: Connections['calendar'], now = Date.now()): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  if (conn?.google) {
    const c = await cached('calendar:google', 10 * 60_000, async () => {
      if (!api.available || !api.signedIn) throw new Error('offline');
      return (await integrations.calendar(HOURS)).events;
    });
    out.push(...(c.value ?? []));
  }
  for (const url of conn?.icsUrls ?? []) {
    const c = await cached(`calendar:ics:${url}`, 30 * 60_000, () => fetchText(url));
    if (c.value) out.push(...parseIcs(c.value, now - 3600_000, now + HOURS * 3600_000));
  }
  // drop finished events; dedupe by title+start (the same event in two calendars)
  const seen = new Set<string>();
  return out
    .filter((e) => (e.end ?? e.start + 3600_000) > now && e.start < now + HOURS * 3600_000)
    .filter((e) => {
      const k = `${e.title.toLowerCase()}|${e.start}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.start - b.start)
    .slice(0, 8);
}

export async function getEmail(conn: Connections['email']): Promise<EmailSummary[]> {
  const out: EmailSummary[] = [];
  if (conn?.gmail) {
    const c = await cached('email:gmail', 10 * 60_000, async () => {
      if (!api.available || !api.signedIn) throw new Error('offline');
      return (await integrations.email(10)).messages;
    });
    out.push(...(c.value ?? []));
  }
  if (conn?.imap) {
    const c = await cached('email:imap', 10 * 60_000, async () => {
      if (!api.available || !api.signedIn) throw new Error('offline');
      return (await request<{ messages: EmailSummary[] }>('GET', '/api/imap/summary')).messages;
    });
    out.push(...(c.value ?? []));
  }
  return out.sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at).slice(0, 6);
}

export async function getNews(feeds: string[]): Promise<Headline[]> {
  const all: Headline[] = [];
  for (const url of feeds.slice(0, 6)) {
    const c = await cached(`news:${url}`, 30 * 60_000, async () => parseFeed(await fetchText(url), new URL(url).hostname.replace(/^www\./, '')));
    all.push(...(c.value ?? []).slice(0, 6));
  }
  // newest first, round-robin-ish across feeds by taking the top of each first
  return all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 10);
}

const INBOX_KEY = 'inbox:items';
const INBOX_USED = 'inbox:used';

/** AI-app notes and segments (MCP connector). New items are merged into a kv list until used on air. */
export async function getInbox(enabled: boolean, now = Date.now()): Promise<InboxItem[]> {
  const prev = (await kvGet<InboxItem[]>(INBOX_KEY))?.value ?? [];
  let items = prev;
  if (enabled && api.available && api.signedIn) {
    try {
      const fresh = (await inboxApi.poll()).items;
      const ids = new Set(prev.map((i) => i.id));
      items = [...prev, ...fresh.filter((i) => !ids.has(i.id))];
    } catch {
      // keep the cached list
    }
  }
  const used = new Set((await kvGet<string[]>(INBOX_USED))?.value ?? []);
  items = items.filter((i) => !used.has(i.id) && (!i.until || i.until > now) && now - i.createdAt < 7 * 86_400_000);
  await kvSet(INBOX_KEY, items);
  return items;
}

/** Marks inbox items as aired so they are not repeated. */
export async function markInboxUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const used = (await kvGet<string[]>(INBOX_USED))?.value ?? [];
  await kvSet(INBOX_USED, [...new Set([...used, ...ids])].slice(-500));
}
