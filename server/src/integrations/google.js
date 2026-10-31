// Google Calendar (next N hours, all calendars), Gmail (unread, important first) and YouTube (playlists incl.
// liked videos, playlist items, search) for the signed-in user.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { googleClient, googleStatus } from './google-auth.js';

const HOUR = 60 * 60 * 1000;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- Calendar ------------------------------------------------------------------------------------------------------

function toEvent(cal, ev) {
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  const start = allDay ? Date.parse(`${ev.start.date}T00:00:00`) : Date.parse(ev.start?.dateTime);
  const endRaw = allDay ? ev.end?.date && Date.parse(`${ev.end.date}T00:00:00`) : ev.end?.dateTime && Date.parse(ev.end.dateTime);
  return {
    id: `${cal.id}:${ev.id}`,
    title: ev.summary?.trim() || 'Busy',
    start,
    end: Number.isFinite(endRaw) ? endRaw : undefined,
    allDay,
    ...(allDay ? { startDate: ev.start.date, endDate: ev.end?.date } : {}),
    location: ev.location || undefined,
    calendar: cal.summaryOverride ?? cal.summary,
    source: 'google',
  };
}

const declined = (ev) => ev.attendees?.some((a) => a.self && a.responseStatus === 'declined');

export async function calendarEvents(app, userId, hours) {
  const api = googleClient(app, userId, 'calendar');
  const list = await api.get('/calendar/v3/users/me/calendarList', { minAccessRole: 'reader', maxResults: 100 });
  const calendars = (list.items ?? []).filter((c) => !c.hidden && !c.deleted);
  const now = Date.now();
  const timeMin = new Date(now - 2 * HOUR).toISOString();
  const timeMax = new Date(now + hours * HOUR).toISOString();
  const perCal = await mapLimit(calendars, 4, async (cal) => {
    try {
      const res = await api.get(`/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`, {
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: 50,
      });
      return (res.items ?? []).filter((ev) => ev.status !== 'cancelled' && !declined(ev)).map((ev) => toEvent(cal, ev));
    } catch (err) {
      if (err.code === 'scope_missing') throw err;
      return []; // one broken calendar must not hide the others
    }
  });
  const events = perCal
    .flat()
    .filter((e) => Number.isFinite(e.start) && (e.end ?? e.start) >= now - HOUR)
    .sort((a, b) => a.start - b.start);
  return { events, calendars: calendars.length };
}

// ---- Gmail ---------------------------------------------------------------------------------------------------------

function header(msg, name) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address stays as is. */
export function displayName(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return m[1].trim() || m[2].trim();
  return from.trim();
}

const decodeEntities = (s) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export async function gmailUnread(app, userId, max) {
  const api = googleClient(app, userId, 'gmail');
  const list = await api.get('/gmail/v1/users/me/messages', { q: 'is:unread in:inbox', maxResults: Math.min(50, max * 3) });
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await mapLimit(ids, 6, (id) =>
    api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    }),
  );
  const rank = (m) => {
    const labels = new Set(m.labelIds ?? []);
    if (labels.has('STARRED') || labels.has('IMPORTANT')) return 0;
    if (labels.has('CATEGORY_PROMOTIONS') || labels.has('CATEGORY_SOCIAL') || labels.has('CATEGORY_FORUMS')) return 2;
    return 1;
  };
  const items = messages
    .map((m) => ({
      id: m.id,
      from: displayName(header(m, 'From')),
      subject: header(m, 'Subject').trim() || '(no subject)',
      snippet: m.snippet ? decodeEntities(m.snippet).slice(0, 200) : undefined,
      important: rank(m) === 0,
      at: Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0,
      _rank: rank(m),
    }))
    .sort((a, b) => a._rank - b._rank || b.at - a.at)
    .slice(0, max)
    .map(({ _rank, ...rest }) => rest);
  return { messages: items, unread: list.resultSizeEstimate ?? ids.length };
}

// ---- YouTube -------------------------------------------------------------------------------------------------------

const thumb = (snippet) =>
  snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.default?.url ?? undefined;

/** ISO 8601 duration (PT1H2M3S) -> ms. */
export function isoDurationMs(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso ?? ''));
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.round(((Number(d) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000);
}

/** Duration and whether the owner allows playback outside YouTube (same quota cost as duration alone). */
async function videoInfo(api, videoIds) {
  const out = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await api.get('/youtube/v3/videos', { part: 'contentDetails,status', id: batch.join(','), maxResults: 50 });
    for (const v of res.items ?? []) out.set(v.id, { durationMs: isoDurationMs(v.contentDetails?.duration), embeddable: v.status?.embeddable !== false });
  }
  return out;
}

/** Items with durationMs, and embeddable: false on the ones the app cannot play (it leaves them out of stations). */
function withInfo(items, info) {
  return items.map((i) => {
    const v = info.get(i.videoId);
    return { ...i, durationMs: v?.durationMs ?? 0, ...(v && !v.embeddable ? { embeddable: false } : {}) };
  });
}

export async function youtubePlaylists(app, userId) {
  const api = googleClient(app, userId, 'youtube');
  const playlists = [];
  let pageToken;
  do {
    const res = await api.get('/youtube/v3/playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50, pageToken });
    for (const p of res.items ?? []) {
      playlists.push({ id: p.id, title: p.snippet?.title ?? 'Playlist', count: p.contentDetails?.itemCount ?? 0, thumbnail: thumb(p.snippet) });
    }
    pageToken = res.nextPageToken;
  } while (pageToken && playlists.length < 200);
  let likedCount = 0;
  try {
    const liked = await api.get('/youtube/v3/playlists', { part: 'contentDetails', id: 'LL' });
    likedCount = liked.items?.[0]?.contentDetails?.itemCount ?? 0;
  } catch (err) {
    if (err.code === 'scope_missing') throw err;
  }
  return { playlists: [{ id: 'LL', title: 'Liked videos', count: likedCount, liked: true }, ...playlists] };
}

/**
 * Playlist items as videos, with what was left out and why: private and deleted videos (YouTube still lists them),
 * and unavailable ones (videos.list does not return them: gone, or nobody may see them). blocked = listed but the
 * owner does not allow playback outside YouTube (the app keeps them and skips them on air).
 * paged: return whole YouTube pages from `pageToken` (about `limit` raw items) and `next` for the following request,
 * so the app can import a long list in steps and show progress. Without it (older apps): the first `limit` videos.
 */
export async function youtubePlaylistItems(app, userId, playlistId, limit, { pageToken, paged = false } = {}) {
  const api = googleClient(app, userId, 'youtube');
  const raw = [];
  let next = pageToken || undefined;
  let total;
  do {
    const res = await api.get('/youtube/v3/playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: 50, pageToken: next });
    raw.push(...(res.items ?? []));
    total ??= res.pageInfo?.totalResults;
    next = res.nextPageToken;
  } while (next && raw.length < limit);
  const left = { private: 0, deleted: 0, unavailable: 0 };
  const listed = [];
  for (const it of raw) {
    const title = it.snippet?.title ?? '';
    const videoId = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId;
    const owned = Boolean(it.snippet?.videoOwnerChannelTitle);
    if (!owned && /^private video$/i.test(title)) left.private++;
    else if (!owned && /^deleted video$/i.test(title)) left.deleted++;
    else if ((!owned && !title) || !videoId) left.unavailable++;
    else listed.push({ videoId, title, channel: (it.snippet?.videoOwnerChannelTitle ?? '').replace(/ - Topic$/, ''), thumbnail: thumb(it.snippet) });
  }
  const wanted = paged ? listed : listed.slice(0, limit);
  const info = await videoInfo(api, wanted.map((i) => i.videoId));
  // videos.list leaves out videos that are gone or that nobody may see: they cannot play anywhere (an empty answer
  // for the whole page is not trusted to mean that)
  const kept = [];
  for (const v of wanted) {
    if (info.has(v.videoId) || !info.size) kept.push(v);
    else left.unavailable++;
  }
  const items = withInfo(kept, info);
  const blocked = items.filter((i) => i.embeddable === false).length;
  return { items, ...(paged && next ? { next } : {}), ...(Number.isFinite(total) ? { total } : {}), left, blocked };
}

export async function youtubeSearch(app, userId, q, { music = true, max = 20 } = {}) {
  const api = googleClient(app, userId, 'youtube');
  const res = await api.get('/youtube/v3/search', {
    part: 'snippet',
    type: 'video',
    q,
    maxResults: max,
    videoCategoryId: music ? '10' : undefined,
    safeSearch: 'moderate',
  });
  const items = (res.items ?? [])
    .map((it) => ({
      videoId: it.id?.videoId,
      title: decodeEntities(it.snippet?.title ?? ''),
      channel: (it.snippet?.channelTitle ?? '').replace(/ - Topic$/, ''),
      thumbnail: thumb(it.snippet),
    }))
    .filter((i) => i.videoId);
  return { items: withInfo(items, await videoInfo(api, items.map((i) => i.videoId))) };
}

// ---- Routes --------------------------------------------------------------------------------------------------------

const intIn = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};

export async function googleRoutes(app) {
  app.get('/api/google/status', async (req) => googleStatus(app, requireUser(req).id));

  app.get('/api/google/calendar', async (req) => {
    const user = requireUser(req);
    return calendarEvents(app, user.id, intIn(req.query?.hours, 1, 24 * 14, 36));
  });

  app.get('/api/google/gmail', async (req) => {
    const user = requireUser(req);
    return gmailUnread(app, user.id, intIn(req.query?.max, 1, 25, 10));
  });

  app.get('/api/google/youtube/playlists', async (req) => youtubePlaylists(app, requireUser(req).id));

  app.get('/api/google/youtube/playlist/:id', async (req) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw new HttpError(400, 'invalid_request', 'Bad playlist id');
    const paged = req.query?.paged === '1';
    const pageToken = req.query?.pageToken ? String(req.query.pageToken) : undefined;
    if (pageToken && !/^[A-Za-z0-9_-]{1,200}$/.test(pageToken)) throw new HttpError(400, 'invalid_request', 'Bad page token');
    return youtubePlaylistItems(app, user.id, id, intIn(req.query?.limit, 1, 500, 200), { pageToken, paged });
  });

  app.get('/api/google/youtube/search', async (req) => {
    const user = requireUser(req);
    const q = String(req.query?.q ?? '').trim();
    if (!q) throw new HttpError(400, 'invalid_request', 'q is required');
    return youtubeSearch(app, user.id, q.slice(0, 200), {
      music: req.query?.music !== '0',
      max: intIn(req.query?.max, 1, 50, 20),
    });
  });
}
