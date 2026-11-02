// Read-only Google lookups the hosts can make (agent tools): one event in full, events by words or a person (past 30
// and next 30 days), Gmail search, one message in full, a whole thread. Same sealed tokens and scopes as the radio.
import { HttpError } from '../errors.js';
import { capText, inviteOf, looksLikeInvite, messageText } from './details.js';
import { googleClient } from './google-auth.js';
import { decodeEntities, displayName, mapLimit, seriesOf, toEmail, toEvent } from './google.js';

const DAY = 86_400_000;

/** Words in a spoken question that name no event ("my meeting today"). */
const SEARCH_STOP = new Set(['the', 'my', 'that', 'this', 'meeting', 'meetings', 'event', 'events', 'call', 'today', 'tomorrow', 'tonight', 'yesterday', 'week', 'next', 'last', 'appointment', 'with', 'about', 'for', 'and', 'what', 'who', 'when', 'coming']);

/** "calendarId:eventId" (the app's event id) -> parts; calendar ids hold no colon, event ids neither. */
export function splitEventId(id) {
  const s = String(id ?? '');
  const at = s.lastIndexOf(':');
  if (at <= 0 || at === s.length - 1) throw new HttpError(400, 'invalid_request', 'Unknown event id');
  return { calId: s.slice(0, at), eventId: s.slice(at + 1) };
}

async function calendars(api) {
  const list = await api.get('/calendar/v3/users/me/calendarList', { minAccessRole: 'reader', maxResults: 100 });
  return (list.items ?? []).filter((c) => !c.hidden && !c.deleted);
}

/** One event with every detail (description up to 2,000 characters). */
export async function eventById(app, userId, id) {
  const { calId, eventId } = splitEventId(id);
  const api = googleClient(app, userId, 'calendar');
  const ev = await api.get(`/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`);
  const cals = await calendars(api).catch(() => []);
  const cal = cals.find((c) => c.id === calId) ?? { id: calId, summary: calId.includes('@') ? 'Calendar' : calId };
  const series = ev.recurringEventId ? await seriesOf(api, userId, calId, [ev.recurringEventId]) : new Map();
  return toEvent(cal, ev, { master: series.get(ev.recurringEventId), max: 2000 });
}

/**
 * Events matching words or a person's name (Google's q matches title, description, location and guests), in the
 * past `back` days and the next `ahead` days (each at most 30), soonest first, at most 12.
 */
export async function searchEvents(app, userId, { query, back = 30, ahead = 30 }) {
  const q = String(query ?? '').trim().slice(0, 120);
  if (!q) throw new HttpError(400, 'invalid_request', 'Say what to look for');
  const api = googleClient(app, userId, 'calendar');
  const now = Date.now();
  const timeMin = new Date(now - Math.min(30, Math.max(0, back)) * DAY).toISOString();
  const timeMax = new Date(now + Math.min(30, Math.max(0, ahead)) * DAY).toISOString();
  const cals = await calendars(api);
  const run = async (words) =>
    (
      await mapLimit(cals, 4, async (cal) => {
        try {
          const res = await api.get(`/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`, { q: words, timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 15 });
          return (res.items ?? []).filter((ev) => ev.status !== 'cancelled').map((ev) => toEvent(cal, ev, { max: 240 }));
        } catch (err) {
          if (err.code === 'scope_missing') throw err;
          return [];
        }
      })
    ).flat();
  let found = await run(q);
  // Google matches every word: "budget review today" finds nothing. Again with the words that name something.
  const keys = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !SEARCH_STOP.has(w));
  if (!found.length && keys.length && keys.join(' ') !== q.toLowerCase()) found = await run(keys.join(' '));
  if (!found.length && keys.length > 1) found = await run(keys.sort((a, b) => b.length - a.length)[0]);
  return found
    .filter((e) => Number.isFinite(e.start))
    .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
    .slice(0, 12)
    .sort((a, b) => a.start - b.start);
}

const header = (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** Gmail search (Gmail's own query words work: from:dana, subject:budget, newer_than:7d), newest first, at most 8. */
export async function gmailSearch(app, userId, query, max = 8) {
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'invalid_request', 'Say what to look for');
  const api = googleClient(app, userId, 'gmail');
  const list = await api.get('/gmail/v1/users/me/messages', { q: `${q} -in:spam -in:trash`, maxResults: Math.min(20, max) });
  const ids = (list.messages ?? []).map((m) => m.id).slice(0, max);
  const msgs = await mapLimit(ids, 6, (id) => api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date', 'Sender'] }));
  return msgs.map((m) => toEmail(m)).sort((a, b) => b.at - a.at);
}

/** One message in full: its text (up to 3,000 characters), links, the invitation it carries. */
export async function gmailRead(app, userId, id) {
  const api = googleClient(app, userId, 'gmail');
  const full = await api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(gmailId(id))}`, { format: 'full' });
  const invite = looksLikeInvite(full) ? inviteOf(full) : undefined;
  const t = await api.get(`/gmail/v1/users/me/threads/${encodeURIComponent(full.threadId)}`, { format: 'minimal', fields: 'messages(id)' }).catch(() => undefined);
  return toEmail(full, { body: messageText(full, 3000), invite, threadSize: t?.messages?.length });
}

/** A whole conversation, oldest first: who wrote what (each message's own words, quotes left out), at most 8. */
export async function gmailThread(app, userId, id) {
  const api = googleClient(app, userId, 'gmail');
  let threadId = gmailId(id);
  const thread = await api.get(`/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`, { format: 'full' }).catch(async (err) => {
    if (err.code !== 'not_found') throw err;
    // a message id: its thread
    const m = await api.get(`/gmail/v1/users/me/messages/${encodeURIComponent(threadId)}`, { format: 'minimal' });
    threadId = m.threadId;
    return api.get(`/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`, { format: 'full' });
  });
  const msgs = (thread.messages ?? []).slice(-8);
  let budget = 6000;
  const messages = msgs.map((m) => {
    const text = messageText(m, Math.max(200, Math.min(1500, budget))).text;
    budget -= text.length;
    return { id: m.id, from: displayName(header(m, 'From')), at: Number(m.internalDate) || 0, text: capText(text, 1500) };
  });
  return { id: threadId, subject: decodeEntities(header(msgs[0] ?? {}, 'Subject')) || '(no subject)', count: thread.messages?.length ?? messages.length, messages };
}

/** The app's mail ids are Gmail ids (hex); anything else is refused before it reaches Google. */
function gmailId(id) {
  const s = String(id ?? '').replace(/^gmail:/, '');
  if (!/^[0-9a-f]{6,32}$/i.test(s)) throw new HttpError(400, 'invalid_request', 'Unknown message id');
  return s;
}
