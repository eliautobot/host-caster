// Google Calendar (next N hours, all calendars), Gmail (unread, important first) and YouTube (playlists incl.
// liked videos, playlist items, search) for the signed-in user.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { eventDetails, inviteOf, looksLikeInvite, messageText } from './details.js';
import { googleClient, googleStatus } from './google-auth.js';

const HOUR = 60 * 60 * 1000;

export async function mapLimit(items, limit, fn) {
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

/**
 * A Google event as the app gets it: when and where, plus the details (description, organizer, guests and their
 * answers, my answer, video call, attachments, how it repeats, link). `master` = the recurring series.
 */
export function toEvent(cal, ev, { master, max } = {}) {
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
    // owner / writer / reader / freeBusyReader: a holiday or other subscribed calendar is read-only (no to-dos from it)
    ...(cal.accessRole ? { calendarRole: cal.accessRole } : {}),
    source: 'google',
    ...eventDetails(ev, { master, max }),
  };
}

/** Recurring series by id (for "weekly"), per user, cached 6 hours. */
const masters = new Map();
const MASTER_TTL = 6 * HOUR;

export async function seriesOf(api, userId, calId, ids) {
  const out = new Map();
  const want = [...new Set(ids)].slice(0, 10);
  await mapLimit(want, 4, async (id) => {
    const key = `${userId}|${calId}|${id}`;
    const hit = masters.get(key);
    if (hit && Date.now() - hit.at < MASTER_TTL) return out.set(id, hit.value);
    try {
      const value = await api.get(`/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`, { fields: 'recurrence' });
      masters.set(key, { at: Date.now(), value });
      if (masters.size > 20000) masters.delete(masters.keys().next().value);
      out.set(id, value);
    } catch (err) {
      if (err.code === 'scope_missing') throw err;
    }
  });
  return out;
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
      const items = (res.items ?? []).filter((ev) => ev.status !== 'cancelled' && !declined(ev));
      const series = await seriesOf(api, userId, cal.id, items.map((ev) => ev.recurringEventId).filter(Boolean));
      return items.map((ev) => toEvent(cal, ev, { master: series.get(ev.recurringEventId) }));
    } catch (err) {
      if (err.code === 'scope_missing') throw err;
      return []; // one broken calendar must not hide the others
    }
  });
  const events = perCal
    .flat()
    .filter((e) => Number.isFinite(e.start) && (e.end ?? e.start) >= now - HOUR)
    .sort((a, b) => a.start - b.start);
  // the Google Calendar's own time zone (the primary calendar): an event added in another zone says so on air
  const timeZone = (list.items ?? []).find((c) => c.primary)?.timeZone;
  return { events, calendars: calendars.length, ...(timeZone ? { timeZone } : {}) };
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

/** "Jane Doe <Jane@Example.com>" -> { address: "jane@example.com" }; nothing when there is no address. */
export function senderAddress(from) {
  const raw = (/<([^>]+)>/.exec(String(from ?? ''))?.[1] ?? String(from ?? '')).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(raw) ? { address: raw.slice(0, 120) } : {};
}

export const decodeEntities = (s) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Gmail's rank for the radio: starred/important first, promotions and social last. */
const rankOf = (m) => {
  const labels = new Set(m.labelIds ?? []);
  if (labels.has('STARRED') || labels.has('IMPORTANT')) return 0;
  if (labels.has('CATEGORY_PROMOTIONS') || labels.has('CATEGORY_SOCIAL') || labels.has('CATEGORY_FORUMS')) return 2;
  return 1;
};

/** The calendar file of an invitation that Gmail keeps as an attachment (for its UID). */
async function inviteFile(api, msg) {
  const parts = [];
  const walk = (p) => (p?.parts?.length ? p.parts.forEach(walk) : parts.push(p));
  walk(msg.payload);
  const part = parts.find((p) => p?.mimeType === 'text/calendar' && p.body?.attachmentId);
  if (!part) return undefined;
  try {
    const att = await api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
    return att?.data ? Buffer.from(String(att.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : undefined;
  } catch (err) {
    if (err.code === 'scope_missing') throw err;
    return undefined;
  }
}

/**
 * One Gmail message as the app gets it. With `full` (a format=full message): its text (clean, capped), links, and the
 * invitation it carries (event id / uid, linked to the calendar on the device).
 */
export function toEmail(m, { body, invite, threadSize } = {}) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: displayName(header(m, 'From')),
    ...senderAddress(header(m, 'From')),
    subject: header(m, 'Subject').trim() || '(no subject)',
    snippet: m.snippet ? decodeEntities(m.snippet).slice(0, 200) : undefined,
    important: rankOf(m) === 0,
    at: Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0,
    ...(body?.text && !body.snippetOnly ? { body: body.text } : {}),
    ...(body?.links?.length ? { links: body.links.slice(0, 4) } : {}),
    ...(invite ? { invite } : {}),
    ...(threadSize > 1 ? { threadSize } : {}),
    source: 'gmail',
  };
}

/** Reads full text for the first few: the hosts tell what a mail says, not only who sent it. */
const FULL_FIRST = 4;
const BODY_MAX = 700;

export async function gmailUnread(app, userId, max) {
  const api = googleClient(app, userId, 'gmail');
  const list = await api.get('/gmail/v1/users/me/messages', { q: 'is:unread in:inbox', maxResults: Math.min(50, max * 3) });
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await mapLimit(ids, 6, (id) =>
    api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'Sender'],
    }),
  );
  const ranked = messages
    .map((m) => ({ m, rank: rankOf(m), at: Number(m.internalDate) || 0 }))
    .sort((a, b) => a.rank - b.rank || b.at - a.at)
    .slice(0, max)
    .map((x) => x.m);
  // the first few and every invitation: the whole message (text, the event it is about) and the thread's size
  const deep = new Set([...ranked.slice(0, FULL_FIRST), ...ranked.filter(looksLikeInvite).slice(0, 4)].map((m) => m.id));
  const items = await mapLimit(ranked, 4, async (m) => {
    if (!deep.has(m.id)) return toEmail(m);
    try {
      const full = await api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { format: 'full' });
      const invite = looksLikeInvite(full) ? inviteOf(full, await inviteFile(api, full)) : undefined;
      let threadSize;
      if (!invite) {
        const t = await api.get(`/gmail/v1/users/me/threads/${encodeURIComponent(full.threadId)}`, { format: 'minimal', fields: 'messages(id)' }).catch(() => undefined);
        threadSize = t?.messages?.length;
      }
      return toEmail(full, { body: messageText(full, BODY_MAX), invite, threadSize });
    } catch (err) {
      if (err.code === 'scope_missing') throw err;
      return toEmail(m);
    }
  });
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

// ---- Watch: what changed since the last check ---------------------------------------------------------------------

const calendarLists = new Map();
const LIST_TTL = 30 * 60 * 1000;

/** The visible calendars (kept 30 minutes: the watch must stay cheap). */
async function visibleCalendars(api, userId) {
  const hit = calendarLists.get(userId);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.items;
  const list = await api.get('/calendar/v3/users/me/calendarList', { minAccessRole: 'reader', maxResults: 100 });
  const items = (list.items ?? []).filter((c) => !c.hidden && !c.deleted).slice(0, 10);
  calendarLists.set(userId, { at: Date.now(), items });
  return items;
}

const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES', 'SPAM'];

/**
 * A new Gmail message for the heads-up check: who, what, and the signs of a mass mailing (a list, an unsubscribe
 * link, bulk precedence, an automatic sender, Gmail's promotions/updates tabs) or of a reply in a conversation.
 */
export function watchMail(m, body) {
  const labels = m.labelIds ?? [];
  const h = (n) => header(m, n);
  const bulk =
    labels.some((l) => BULK_LABELS.includes(l)) ||
    Boolean(h('List-Unsubscribe') || h('List-Id')) ||
    /bulk|list|junk/i.test(h('Precedence')) ||
    /auto-(generated|replied)/i.test(h('Auto-Submitted')) ||
    /no-?reply|newsletter|notifications?@|mailer-daemon|marketing|news@/i.test(h('From'));
  return {
    ...toEmail(m, { body }),
    bulk,
    ...(h('In-Reply-To') || h('References') ? { reply: true } : {}),
    ...(labels.includes('IMPORTANT') ? { gmailImportant: true } : {}),
    ...(labels.includes('STARRED') ? { starred: true } : {}),
    address: (/<([^>]+)>/.exec(h('From'))?.[1] ?? h('From')).trim().toLowerCase().slice(0, 120),
  };
}

/**
 * Cheap change check while the radio plays (every few minutes): calendar events changed since `since` in the next
 * `hours` (cancelled ones too: only their id is certain), and Gmail messages added to the inbox since `historyId`
 * (the first call only returns the current historyId). Each part is left out when its access is missing.
 */
export async function googleWatch(app, userId, { since, historyId, hours = 12 }) {
  const out = {};
  const now = Date.now();
  try {
    const api = googleClient(app, userId, 'calendar');
    const cals = await visibleCalendars(api, userId);
    // Google refuses an updatedMin older than about four weeks; a day back is plenty
    const from = Math.max(now - 24 * HOUR, Math.min(now, Number(since) || now) - 60_000);
    const per = await mapLimit(cals, 4, async (cal) => {
      try {
        const res = await api.get(`/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`, {
          updatedMin: new Date(from).toISOString(),
          timeMin: new Date(now - 15 * 60_000).toISOString(),
          timeMax: new Date(now + hours * HOUR).toISOString(),
          singleEvents: 'true',
          showDeleted: 'true',
          maxResults: 50,
        });
        return (res.items ?? []).map((ev) =>
          ev.status === 'cancelled' || declined(ev)
            ? {
                // the same id the event had in the day's list
                id: `${cal.id}:${ev.id}`,
                cancelled: true,
                ...(declined(ev) ? { declinedByMe: true } : {}),
                ...(ev.summary ? { title: ev.summary } : {}),
                ...(ev.originalStartTime?.dateTime ? { start: Date.parse(ev.originalStartTime.dateTime) } : ev.start?.dateTime ? { start: Date.parse(ev.start.dateTime) } : {}),
              }
            : toEvent(cal, ev),
        );
      } catch (err) {
        if (err.code === 'scope_missing' || err.code === 'upstream_rate_limited') throw err;
        return [];
      }
    });
    out.calendar = { changed: per.flat(), checkedAt: now };
  } catch (err) {
    if (err.code === 'upstream_rate_limited') throw err;
  }
  try {
    const api = googleClient(app, userId, 'gmail');
    const fresh = async () => ({ historyId: String((await api.get('/gmail/v1/users/me/profile')).historyId ?? ''), messages: [] });
    if (!historyId) out.gmail = await fresh();
    else {
      let res;
      try {
        res = await api.get('/gmail/v1/users/me/history', { startHistoryId: String(historyId), historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: 50 });
      } catch (err) {
        // a history id too old (or unknown) starts over from now
        if (err.code !== 'not_found') throw err;
      }
      if (!res) out.gmail = await fresh();
      else {
        const ids = [
          ...new Set(
            (res.history ?? [])
              .flatMap((h) => h.messagesAdded ?? [])
              .map((a) => a.message)
              .filter((m) => m?.id && (m.labelIds ?? ['INBOX']).includes('INBOX'))
              .map((m) => m.id),
          ),
        ].slice(-8);
        const messages = await mapLimit(ids, 4, async (id) => {
          try {
            const m = await api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' });
            return watchMail(m, messageText(m, BODY_MAX));
          } catch (err) {
            if (err.code === 'scope_missing') throw err;
            return undefined;
          }
        });
        out.gmail = { historyId: String(res.historyId ?? historyId), messages: messages.filter(Boolean) };
      }
    }
  } catch (err) {
    if (err.code === 'upstream_rate_limited') throw err;
  }
  return out;
}

// ---- Google Tasks --------------------------------------------------------------------------------------------------

const TASK_LISTS_MAX = 10;
const TASKS_PER_LIST = 300;
const DONE_KEEP_MS = 3 * 24 * HOUR;

/** One Google task as the app gets it (due as "YYYY-MM-DD": Google keeps only the day). */
export function toTask(t, list) {
  return {
    id: t.id,
    listId: list.id,
    listTitle: String(list.title ?? ''),
    title: String(t.title ?? '').trim(),
    ...(t.notes ? { notes: String(t.notes).slice(0, 1000) } : {}),
    ...(t.due ? { due: String(t.due).slice(0, 10) } : {}),
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    ...(t.completed ? { completed: t.completed } : {}),
    updated: t.updated,
    ...(t.webViewLink ? { link: t.webViewLink } : {}),
  };
}

/** Open tasks and the ones done in the last 3 days: up to 10 lists, 300 tasks each. */
export async function googleTasks(app, userId) {
  const api = googleClient(app, userId, 'tasks');
  const res = await api.get('/tasks/v1/users/@me/lists', { maxResults: TASK_LISTS_MAX });
  const lists = (res.items ?? []).slice(0, TASK_LISTS_MAX).map((l) => ({ id: l.id, title: String(l.title ?? '') }));
  const since = Date.now() - DONE_KEEP_MS;
  const perList = await mapLimit(lists, 4, async (list) => {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10 && out.length < TASKS_PER_LIST; page++) {
      const r = await api.get(`/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks`, { showCompleted: 'true', showHidden: 'true', maxResults: 100, pageToken });
      for (const t of r.items ?? []) {
        if (t.deleted || !String(t.title ?? '').trim()) continue;
        if (t.status === 'completed' && !(Date.parse(t.completed ?? t.updated) >= since)) continue;
        out.push(toTask(t, list));
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out.slice(0, TASKS_PER_LIST);
  });
  return { lists, tasks: perList.flat() };
}

// ---- Known senders -------------------------------------------------------------------------------------------------

/** "has the listener ever written to this address" per user, 7 days */
const knownCache = new Map();
const KNOWN_TTL = 7 * 24 * HOUR;
const EMAIL_RE = /^[^\s@"<>()\[\],;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * { known: { address: true|false } }: true when the listener's Sent mail has a message to that address (so a mail
 * from it is not from a stranger). Without Gmail: { known: {} } (the app treats unknown as new).
 */
export async function knownSenders(app, userId, emails) {
  let api;
  try {
    api = googleClient(app, userId, 'gmail');
  } catch {
    return { known: {} };
  }
  const known = {};
  const now = Date.now();
  const todo = [];
  for (const email of emails) {
    const hit = knownCache.get(`${userId}|${email}`);
    if (hit && now - hit.at < KNOWN_TTL) known[email] = hit.known;
    else todo.push(email);
  }
  let stop = false;
  await mapLimit(todo, 4, async (email) => {
    if (stop) return;
    try {
      const res = await api.get('/gmail/v1/users/me/messages', { q: `in:sent to:${email}`, maxResults: 1 });
      known[email] = Boolean(res.messages?.length);
      knownCache.set(`${userId}|${email}`, { at: Date.now(), known: known[email] });
      if (knownCache.size > 50000) knownCache.delete(knownCache.keys().next().value);
    } catch (err) {
      // no Gmail access (any more) or Google says slow down: what is known so far
      if (err.code === 'scope_missing' || err.code === 'upstream_rate_limited') stop = true;
    }
  });
  return { known };
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

  // the heads-up check while the radio plays: what changed since the last one
  app.get('/api/google/watch', async (req) => {
    const user = requireUser(req);
    const historyId = /^\d{1,24}$/.test(String(req.query?.historyId ?? '')) ? String(req.query.historyId) : undefined;
    return googleWatch(app, user.id, { since: Number(req.query?.since) || undefined, historyId, hours: intIn(req.query?.hours, 1, 24, 12) });
  });

  app.get('/api/google/tasks', async (req) => googleTasks(app, requireUser(req).id));

  app.post('/api/google/known-senders', async (req) => {
    const user = requireUser(req);
    const raw = req.body?.emails;
    if (!Array.isArray(raw) || raw.length > 40) throw new HttpError(400, 'invalid_request', 'emails must be a list of at most 40 addresses');
    const emails = [...new Set(raw.filter((e) => typeof e === 'string').map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
    if (!emails.length) return { known: {} };
    return knownSenders(app, user.id, emails);
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
