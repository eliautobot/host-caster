// Builds the packet the hosts talk from. Every source is optional, time-boxed and cached: a slow or offline source
// is simply left out, so a break is never late because of it.
import { getProfile, getSettings, listBreaks } from '../db';
import type { ContextPacket, Station, Track, TrackSummary } from '../types';
import { partOfDay } from '../util/time';
import { within } from './cache';
import { activeNotes, dueLifeEvents, dueReminders } from './life';
import { getCalendar, getEmail, getInbox, getNews } from './sources';
import { getWeather } from './weather';

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
  const [profile, settings, recentBreaks] = await Promise.all([getProfile(), getSettings(), listBreaks(station.id, 8)]);
  const seg = station.segments;
  const conn = settings.connections;

  const weatherOn = seg.weather && profile.location && conn.weather?.enabled !== false;
  const calendarOn = seg.calendar && (conn.calendar?.google || (conn.calendar?.icsUrls?.length ?? 0) > 0);
  const emailOn = seg.email && (conn.email?.gmail || conn.email?.imap);
  const newsOn = seg.news && station.newsFeeds.length > 0 && conn.news?.enabled !== false;

  const [weather, calendar, email, news, inbox] = await Promise.all([
    weatherOn ? within(getWeather(profile.location!, profile.units), budget) : undefined,
    calendarOn ? within(getCalendar(conn.calendar, nowMs), budget) : undefined,
    emailOn ? within(getEmail(conn.email), budget) : undefined,
    newsOn ? within(getNews(station.newsFeeds), budget) : undefined,
    within(getInbox(conn.aiApps?.enabled !== false, nowMs), budget),
  ]);

  const lifeEvents = seg.lifeEvents ? dueLifeEvents(profile.lifeEvents, nowMs).map((i) => i.event) : [];
  const notes = seg.notes ? activeNotes(profile.notes, nowMs) : [];
  const reminders = seg.reminders ? dueReminders(profile.reminders, nowMs) : [];

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
  };
}
