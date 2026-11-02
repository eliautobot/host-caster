// What the hosts can look up on the server, where the data lives: Google Calendar and Gmail (the user's own sign-in),
// IMAP, the Notion pages the user allowed, a linked web page (through the egress guard) and web search. Read-only.
// Every result is small plain data (the app hands it to the model as JSON); each call says in a few words what was
// read, for the Lookups log.
import { HttpError } from '../errors.js';
import { capText } from '../integrations/details.js';
import { eventById, gmailRead, gmailSearch, gmailThread, searchEvents } from '../integrations/google-agent.js';
import { googleStatus } from '../integrations/google-auth.js';
import { imapConfigured, imapRead, imapSearch } from '../integrations/imap.js';
import { checkId, notionClient } from '../integrations/notion/api.js';
import { readContext } from '../integrations/notion/read.js';
import { getLink } from '../integrations/notion/store.js';
import { pageSummary, titleOf } from '../integrations/notion/text.js';
import { userRequest } from '../net/http.js';
import { readablePage } from './readable.js';
import { searchWeb } from './search.js';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/** A time as the listener says it ("Sunday, November 1, 12:15 PM"), in their time zone (models misread UTC). */
export function whenIn(ms, tz) {
  if (!Number.isFinite(ms)) return undefined;
  const opts = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || undefined }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(ms);
  }
}
const short = (s, n = 60) => capText(String(s ?? ''), n);

/** An event for the model: only what helps (times in the listener's words and zone). */
function eventOut(e, tz) {
  return {
    id: e.id,
    title: e.title,
    start: e.allDay ? e.startDate : whenIn(e.start, tz),
    ...(e.end && !e.allDay ? { end: whenIn(e.end, tz) } : {}),
    ...(e.allDay ? { allDay: true } : {}),
    ...Object.fromEntries(
      ['location', 'calendar', 'description', 'organizer', 'creator', 'guests', 'attendees', 'rooms', 'myResponse', 'invitation', 'attachments', 'recurrence', 'links']
        .filter((k) => e[k] !== undefined)
        .map((k) => [k, e[k]]),
    ),
    ...(e.video ? { video: e.video.provider } : {}),
  };
}

const mailOut = (m, tz) => ({
  id: m.id,
  from: m.from,
  subject: m.subject,
  at: whenIn(m.at, tz),
  ...(m.snippet && !m.body ? { snippet: m.snippet } : {}),
  ...(m.body ? { text: m.body } : {}),
  ...(m.links?.length ? { links: m.links } : {}),
  ...(m.threadSize ? { messagesInThread: m.threadSize } : {}),
  ...(m.invite ? { invitation: m.invite } : {}),
});

function hasGoogle(app, userId, scope) {
  const st = googleStatus(app, userId);
  return st.connected && st.scopes.includes(scope);
}

/** Which lookups this account can make here (the app offers the model only these). */
export function serverTools(app, userId) {
  const search = app.config.agent.search;
  const web = search.provider === 'hostcaster' ? Boolean(app.included?.webSearchOpen?.(userId)) : Boolean(search.provider);
  const notion = Boolean(getLink(app, userId)?.settings?.read?.length);
  return {
    calendar: hasGoogle(app, userId, 'calendar'),
    gmail: hasGoogle(app, userId, 'gmail'),
    imap: imapConfigured(app, userId),
    notion,
    web: web && app.config.agent.webSearchesPerDay > 0,
    webProvider: search.provider || undefined,
    links: true,
  };
}

async function readLink(app, url) {
  const u = str(url, 2000);
  if (!/^https?:\/\//i.test(u)) throw new HttpError(400, 'invalid_url', 'Only web links (http or https) can be opened');
  const res = await userRequest(app.egressCtx, u, {
    headers: { accept: 'text/html, application/xhtml+xml, text/plain;q=0.9, application/json;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; Host-Caster lookups)' },
    timeoutMs: 12000,
    maxBytes: MAX_PAGE_BYTES,
  });
  if (res.status === 401 || res.status === 403) return { url: u, error: 'This page needs a sign-in, so the hosts cannot read it.' };
  if (res.status < 200 || res.status >= 300) return { url: u, error: `The page answered HTTP ${res.status}.` };
  const type = String(res.headers['content-type'] ?? 'text/html');
  if (/pdf|image|audio|video|octet-stream|zip/i.test(type)) return { url: u, error: 'That link is a file, not a page the hosts can read.' };
  const page = readablePage(res.body.toString('utf8'), type);
  if (/sign in|log in|login/i.test(page.title ?? '') && page.text.length < 400) return { url: u, error: 'This page needs a sign-in, so the hosts cannot read it.' };
  return { url: res.url ?? u, ...page };
}

async function notionSearch(app, userId, query) {
  const words = str(query, 120).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) throw new HttpError(400, 'invalid_request', 'Say what to look for');
  const { notes } = await readContext(app, userId);
  const found = [];
  for (const n of notes) {
    const lines = n.text.split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w)));
    const inTitle = words.some((w) => n.title.toLowerCase().includes(w));
    if (lines.length || inTitle) found.push({ id: n.id, title: n.title, lines: (lines.length ? lines : n.text.split('\n')).slice(0, 8) });
  }
  return { pages: found.slice(0, 6), searched: notes.map((n) => n.title).slice(0, 10) };
}

/** A page the user allowed, a row of an allowed database, or a page inside an allowed page. */
async function notionRead(app, userId, id) {
  const link = getLink(app, userId);
  if (!link?.settings?.read?.length) throw new HttpError(409, 'notion_not_connected', 'No Notion pages are shared with the hosts');
  const pageId = checkId(str(id, 64));
  const allowed = new Set(link.settings.read.map((r) => r.id.replace(/-/g, '')));
  const client = notionClient(app, userId);
  const page = await client.call('GET', `/v1/pages/${pageId}`);
  const parent = page.parent ?? {};
  const parentId = String(parent.data_source_id ?? parent.database_id ?? parent.page_id ?? '').replace(/-/g, '');
  if (!allowed.has(pageId.replace(/-/g, '')) && !allowed.has(parentId)) throw new HttpError(403, 'not_allowed', 'That Notion page is not one the hosts may read');
  if (page.in_trash || page.archived) return { id: pageId, title: titleOf(page), error: 'In the Notion trash' };
  const blocks = await client.call('GET', `/v1/blocks/${pageId}/children?page_size=100`);
  return { id: pageId, title: titleOf(page) || 'Untitled', text: pageSummary(blocks.results ?? [], 3000), edited: page.last_edited_time };
}

/** Gmail ids are hex; IMAP ids start with "imap:". */
const isImap = (id) => /^imap:/.test(String(id ?? ''));

/**
 * Runs one lookup. @returns {Promise<{ result: object, what: string, costUsd?: number }>}
 */
export async function runServerTool(app, userId, name, args = {}, { tz } = {}) {
  const avail = serverTools(app, userId);
  const need = (on, msg) => {
    if (!on) throw new HttpError(409, 'tool_unavailable', msg);
  };
  switch (name) {
    case 'calendar_event': {
      need(avail.calendar, 'Google Calendar is not connected');
      const e = await eventById(app, userId, str(args.id, 1100));
      return { result: eventOut(e, tz), what: `Calendar event: ${short(e.title)}` };
    }
    case 'calendar_search': {
      need(avail.calendar, 'Google Calendar is not connected');
      const back = Number.isFinite(Number(args.days_back)) ? Number(args.days_back) : 30;
      const ahead = Number.isFinite(Number(args.days_ahead)) ? Number(args.days_ahead) : 30;
      const events = await searchEvents(app, userId, { query: args.query ?? args.person, back, ahead });
      return { result: { events: events.map((e) => eventOut(e, tz)) }, what: `Calendar search: "${short(args.query ?? args.person, 40)}" (${events.length} found)` };
    }
    case 'email_search': {
      need(avail.gmail || avail.imap, 'No mailbox is connected');
      const q = str(args.query, 200);
      const [g, i] = await Promise.all([
        avail.gmail ? gmailSearch(app, userId, q) : [],
        avail.imap ? imapSearch(app, userId, q).catch(() => []) : [],
      ]);
      const mails = [...g, ...i].sort((a, b) => b.at - a.at).slice(0, 8);
      return { result: { emails: mails.map((m) => mailOut(m, tz)) }, what: `Email search: "${short(q, 40)}" (${mails.length} found)` };
    }
    case 'email_read': {
      const id = str(args.id, 80);
      need(isImap(id) ? avail.imap : avail.gmail, 'That mailbox is not connected');
      const m = isImap(id) ? await imapRead(app, userId, id) : await gmailRead(app, userId, id);
      return { result: mailOut(m, tz), what: `Email: "${short(m.subject, 50)}" from ${short(m.from, 30)}` };
    }
    case 'email_thread': {
      const id = str(args.id, 80);
      if (isImap(id)) {
        need(avail.imap, 'That mailbox is not connected');
        const m = await imapRead(app, userId, id);
        return { result: { subject: m.subject, count: 1, messages: [{ from: m.from, at: whenIn(m.at, tz), text: m.body }] }, what: `Email: "${short(m.subject, 50)}"` };
      }
      need(avail.gmail, 'Gmail is not connected');
      const t = await gmailThread(app, userId, id);
      return {
        result: { subject: t.subject, count: t.count, messages: t.messages.map((m) => ({ from: m.from, at: whenIn(m.at, tz), text: m.text })) },
        what: `Email thread: "${short(t.subject, 50)}" (${t.count} messages)`,
      };
    }
    case 'notion_search': {
      need(avail.notion, 'No Notion pages are shared with the hosts');
      const r = await notionSearch(app, userId, args.query);
      return { result: r, what: `Notion search: "${short(args.query, 40)}" (${r.pages.length} found)` };
    }
    case 'notion_read': {
      need(avail.notion, 'No Notion pages are shared with the hosts');
      const r = await notionRead(app, userId, args.id);
      return { result: r, what: `Notion page: ${short(r.title)}` };
    }
    case 'open_link':
    case 'news_article': {
      const r = await readLink(app, args.url);
      let host = '';
      try {
        host = new URL(r.url).host.replace(/^www\./, '');
      } catch {
        // shown as is
      }
      return { result: r, what: `${name === 'news_article' ? 'News article' : 'Web page'}: ${short(r.title || host, 60)}${r.title && host ? ` (${host})` : ''}` };
    }
    case 'web_search': {
      need(avail.web, 'Web search is not set up');
      const q = str(args.query, 300);
      if (!q) throw new HttpError(400, 'invalid_request', 'Say what to search for');
      if (app.config.agent.search.provider === 'hostcaster') {
        const r = await app.included.webSearch(userId, q);
        return { result: { answer: r.text, sources: r.sources }, what: `Web search: "${short(q, 50)}"`, costUsd: r.costUsd };
      }
      const r = await searchWeb(app.config.agent.search, q);
      return { result: { results: r.text, sources: r.sources }, what: `Web search: "${short(q, 50)}"` };
    }
    default:
      throw new HttpError(400, 'unknown_tool', `There is no lookup called ${str(name, 40)}`);
  }
}
