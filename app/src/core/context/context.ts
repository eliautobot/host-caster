// Builds the packet the hosts talk from. Every source is optional, time-boxed and cached: a slow or offline source
// is simply left out, so a break is never late because of it.
import { getProfile, getSettings, listBreaks } from '../db';
import type { ContextPacket, Station, Track, TrackSummary } from '../types';
import { partOfDay } from '../util/time';
import { within } from './cache';
import { activeNotes, dueLifeEvents, dueReminders } from './life';
import { pendingHeadsUps } from '../agent/headsup';
import { accountNews, deviceHints, stationFeeds } from './news';
import { feedsReachable, getCalendar, getEmail, getInbox, getNews } from './sources';
import { getNotionNotes } from './notion';
import { getWeather } from './weather';

/**
 * Breaks the planner remembers: enough for its item cooldowns (a headline rests 12 hours, a mail 6) to hold over a
 * long session. The prompt shows only the newest few.
 */
export const RECENT_BREAKS = 60;

export interface ContextSongs {
  songBefore?: TrackSummary;
  songAfter?: TrackSummary;
  upcomingSongs?: Track[];
}

export interface ContextOptions {
  now?: number;
  /** per-source time budget (ms) */
  budgetMs?: number;
}

export function summarize(t: Track | TrackSummary | undefined): TrackSummary | undefined {
  if (!t) return undefined;
  return { id: t.id, title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, source: t.source };
}

export async function buildContext(station: Station, songs: ContextSongs = {}, opts: ContextOptions = {}): Promise<ContextPacket> {
  const nowMs = opts.now ?? Date.now();
  const date = new Date(nowMs);
  const budget = opts.budgetMs ?? 8000;
  const [profile, settings, recentBreaks] = await Promise.all([getProfile(), getSettings(), listBreaks(station.id, RECENT_BREAKS)]);
  const seg = station.segments;
  const conn = settings.connections;

  const weatherOn = seg.weather && profile.location && conn.weather?.enabled !== false;
  const calendarOn = seg.calendar && (conn.calendar?.google || (conn.calendar?.icsUrls?.length ?? 0) > 0);
  const emailOn = seg.email && (conn.email?.gmail || conn.email?.imap);
  // a station with no feeds of its own reads the account's (the listener's region defaults unless they chose others)
  const account = accountNews(conn.news, { place: profile.location, ...deviceHints() });
  const feeds = stationFeeds(station, account);
  // the default feeds only where they can be read (feeds the listener chose were checked when added)
  const chosen = station.newsFeeds.length > 0 || account.custom;
  const newsOn = seg.news && feeds.length > 0 && account.enabled && (chosen || feedsReachable());
  // Notion pages the listener chose go with their own notes
  const notionNotes = seg.notes && conn.notion?.connected ? within(getNotionNotes(nowMs), budget) : undefined;

  const [weather, calendar, email, news, inbox] = await Promise.all([
    weatherOn ? within(getWeather(profile.location!, profile.units), budget) : undefined,
    calendarOn ? within(getCalendar(conn.calendar, nowMs), budget) : undefined,
    emailOn ? within(getEmail(conn.email), budget) : undefined,
    newsOn ? within(getNews(feeds), budget) : undefined,
    within(getInbox(conn.aiApps?.enabled !== false, nowMs), budget),
  ]);

  const lifeEvents = seg.lifeEvents ? dueLifeEvents(profile.lifeEvents, nowMs).map((i) => i.event) : [];
  const notes = seg.notes ? [...activeNotes(profile.notes, nowMs), ...((await notionNotes) ?? [])] : [];
  const reminders = seg.reminders ? dueReminders(profile.reminders, nowMs) : [];
  // something important that just changed (calendar or mail) and was not told yet: it opens the break
  const headsUps = (await pendingHeadsUps().catch(() => [])).filter((h) => (h.mailId ? seg.email : seg.calendar));

  return {
    now: {
      iso: date.toISOString(),
      local: date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
      partOfDay: partOfDay(date),
      weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
    },
    listener: {
      name: profile.name,
      callMe: profile.callMe || profile.name,
      about: profile.about,
      interests: profile.interests,
      avoid: profile.avoidTopics,
    },
    songBefore: summarize(songs.songBefore),
    songAfter: summarize(songs.songAfter),
    upcomingSongs: (songs.upcomingSongs ?? []).slice(0, 3),
    weather,
    calendar: calendar?.length ? calendar : undefined,
    email: email?.length ? email : undefined,
    news: news?.length ? news : undefined,
    lifeEvents: lifeEvents.length ? lifeEvents : undefined,
    notes: notes.length ? notes : undefined,
    reminders: reminders.length ? reminders : undefined,
    // song requests are queued by the radio itself (core/radio/requests), not talked about as notes
    inbox: inbox?.some((i) => i.kind !== 'song_request') ? inbox.filter((i) => i.kind !== 'song_request') : undefined,
    recentBreaks,
    ...(headsUps.length ? { headsUps } : {}),
  };
}
