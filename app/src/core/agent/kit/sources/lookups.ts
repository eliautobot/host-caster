// The look-ups (read only) as kit tools: the 14 the hosts always had (agent/tools.ts runs them), plus the
// listener's Google Tasks and their music library. Each says why it is not offered and where to turn it on.
import { listTracks } from '../../../db/library';
import type { CalendarEvent, Track } from '../../../types';
import { invites } from '../../../actions/callin';
import { getCalendar } from '../../../context/sources';
import { dayOffset, localWhen, runTool, TOOL_SPECS, type ToolName } from '../../tools';
import { OK, off, type AgentEnv, type AgentTool, type Availability } from '../types';
import { googleTasks } from './gtasks';
import { contentWords, FIX, needGoogle, needServer, str } from './needs';

const GROUP: Record<ToolName, string> = {
  calendar_event: 'Calendar',
  calendar_search: 'Calendar',
  email_search: 'Email',
  email_read: 'Email',
  email_thread: 'Email',
  notion_search: 'Notion',
  notion_read: 'Notion',
  open_link: 'Web',
  news_article: 'News',
  weather: 'Weather',
  web_search: 'Web',
  memory_search: 'What you remember',
  journal_search: 'What you remember',
  my_list: 'Your list',
};

/** the look-ups most turns use: their schemas go with every turn (docs/AGENT.md, section 1) */
const CORE = new Set<ToolName>(['calendar_event', 'calendar_search', 'email_search', 'my_list', 'weather', 'web_search']);

const KEYWORDS: Partial<Record<ToolName, string[]>> = {
  calendar_search: ['when is', 'meeting', 'appointment', 'event', 'schedule'],
  email_search: ['mail', 'inbox', 'message from', 'wrote'],
  weather: ['rain', 'sunny', 'temperature', 'forecast', 'umbrella'],
  memory_search: ['remember', 'told you', 'recall'],
  my_list: ['to do', 'todo', 'reminders', 'what is left', 'due'],
  web_search: ['look up', 'search', 'find out', 'score', 'news'],
};

const TITLE: Record<ToolName, string> = {
  calendar_event: 'Read an event in full',
  calendar_search: 'Search the calendar',
  email_search: 'Search email',
  email_read: 'Read an email',
  email_thread: 'Read an email conversation',
  notion_search: 'Search Notion pages',
  notion_read: 'Read a Notion page',
  open_link: 'Open a linked page',
  news_article: 'Read a news article',
  weather: 'Check the weather',
  web_search: 'Search the web',
  memory_search: 'Look in memory',
  journal_search: 'Look at what happened lately',
  my_list: 'Read Your list',
};

/** The listener's switch for look-ups (Settings, What your hosts can see). my_list stays: it is their own list. */
const lookupsOff = (env: AgentEnv) => env.connections.lookups?.enabled === false;

function lookupAvailable(name: ToolName, env: AgentEnv): Availability {
  if (name === 'my_list') return OK;
  if (lookupsOff(env)) return off('switched-off', FIX.lookups);
  const t = env.server;
  const ics = (env.connections.calendar?.icsUrls?.length ?? 0) > 0;
  switch (name) {
    case 'calendar_event':
    case 'calendar_search':
      if (t?.calendar || ics) return OK;
      return env.signedIn ? off('not-connected', FIX.calendar) : off('signed-out', FIX.signIn);
    case 'email_search':
    case 'email_read':
    case 'email_thread':
      if (t?.gmail || t?.imap) return OK;
      return env.signedIn ? off('not-connected', FIX.email) : off('signed-out', FIX.signIn);
    case 'notion_search':
    case 'notion_read':
      if (t?.notion) return OK;
      return env.signedIn ? off('not-connected', FIX.notion) : off('signed-out', FIX.signIn);
    case 'open_link':
      return t?.links ? OK : needServer(env).ok ? off('unavailable', FIX.online) : needServer(env);
    case 'news_article':
      if (!t?.links) return needServer(env).ok ? off('unavailable', FIX.online) : needServer(env);
      return env.ctx.headlines.length ? OK : off('unavailable', 'There are no headlines right now');
    case 'web_search':
      if (env.connections.lookups?.web === false) return off('switched-off', FIX.web);
      if (t?.web) return OK;
      return env.signedIn ? off('unavailable', 'Web search is not offered on this server') : off('signed-out', FIX.signIn);
    default:
      return OK;
  }
}

function lookupTool(name: ToolName): AgentTool {
  const spec = TOOL_SPECS[name];
  return {
    name,
    title: TITLE[name],
    group: GROUP[name],
    description: name === 'calendar_search' ? `${spec.description} It matches words, not days: for what is on a day, use calendar_day.` : spec.description,
    parameters: spec.parameters,
    kind: 'read',
    ...(CORE.has(name) ? { core: true } : {}),
    ...(KEYWORDS[name] ? { keywords: KEYWORDS[name] } : {}),
    available: (env) => lookupAvailable(name, env),
    async run(args, run) {
      const out = await runTool(name, args, run.env.ctx, run.signal);
      return { ok: out.ok, content: out.content, what: out.what };
    },
  };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });

const googleTasksTool: AgentTool = {
  name: 'google_tasks',
  title: 'Read Google Tasks',
  group: 'Google Tasks',
  description: "The listener's Google Tasks: their lists, and the tasks in them (open ones, and ones done in the last 3 days), with ids for changing them.",
  parameters: obj({ list: s('a list name to show only that list; optional'), query: s('words to look for; optional'), done: { type: 'boolean', description: 'true to show done tasks too' } }),
  kind: 'read',
  core: true,
  keywords: ['task', 'tasks', 'to do', 'todo', 'list', 'lists'],
  available: (env) => needGoogle(env, 'tasks'),
  async run(args) {
    const { lists, tasks } = await googleTasks();
    const list = str(args.list, 80).toLowerCase();
    const words = contentWords(str(args.query, 120));
    const hits = tasks
      .filter((t) => (args.done === true ? true : t.status !== 'completed'))
      .filter((t) => !list || (t.listTitle ?? '').toLowerCase().includes(list) || t.listId === list)
      .filter((t) => !words.length || words.some((w) => contentWords(`${t.title} ${t.notes ?? ''}`).includes(w)))
      .slice(0, 40)
      .map((t) => ({ task_id: t.id, list_id: t.listId, list: t.listTitle, title: t.title, ...(t.due ? { due: t.due } : {}), ...(t.status === 'completed' ? { done: true } : {}), ...(t.notes ? { notes: t.notes.slice(0, 160) } : {}) }));
    return { ok: true, content: { lists: lists.map((l) => ({ list_id: l.id, title: l.title })), tasks: hits }, what: `Google Tasks: ${hits.length} found` };
  },
};

const DAY_MS = 86_400_000;

/** The listener's events on one day (Google, the next two weeks, and calendar feeds): "what's on tomorrow?". */
const calendarDayTool: AgentTool = {
  name: 'calendar_day',
  title: 'See a day on the calendar',
  group: 'Calendar',
  description: "Every event on one day of the listener's calendar (today up to 13 days ahead), in time order, for \"what's on Friday?\". When your facts already list that day as complete, answer from them instead.",
  parameters: obj({ day: s('"today", "tomorrow", a weekday or YYYY-MM-DD') }, ['day']),
  kind: 'read',
  core: true,
  keywords: ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'week', 'busy', 'free', 'schedule', 'agenda'],
  available: (env) => lookupAvailable('calendar_search', env),
  async run(args, run) {
    const now = new Date();
    const n = dayOffset(args.day, now) ?? (/^\d{4}-\d{2}-\d{2}$/.test(str(args.day, 10)) ? Math.round((Date.parse(`${str(args.day, 10)}T12:00:00`) - new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime()) / DAY_MS) : undefined);
    if (n === undefined || n < 0 || n > 13) return { ok: false, content: { error: 'Give a day from today up to 13 days ahead.' }, what: 'Calendar day (which day?)' };
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n).getTime();
    const to = from + DAY_MS;
    const google = run.env.connections.calendar?.google ? await invites().catch(() => [] as CalendarEvent[]) : [];
    const feeds = await getCalendar({ google: false, icsUrls: run.env.connections.calendar?.icsUrls ?? [] }).catch(() => [] as CalendarEvent[]);
    const events = [...google, ...feeds]
      .filter((e) => e.start < to && (e.end ?? e.start + 1) > from)
      .sort((a, b) => a.start - b.start)
      .slice(0, 20)
      .map((e) => ({ id: e.id, title: e.title, ...(e.allDay ? { allDay: true } : { start: localWhen(e.start), ...(e.end ? { end: localWhen(e.end) } : {}) }), ...(e.location ? { location: e.location } : {}), ...(e.organizerSelf === false && e.organizer ? { organizer: e.organizer } : {}) }));
    const label = n === 0 ? 'today' : n === 1 ? 'tomorrow' : new Date(from).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return { ok: true, content: { day: label, events }, what: `Calendar: ${label} (${events.length} events)` };
  },
};

/** Songs in the library that best match the words (title, artist, album). */
export function searchSongs(query: string, tracks: Track[], max = 8): Track[] {
  const words = contentWords(query);
  if (!words.length) return [];
  const scored = tracks
    .map((t) => {
      const hay = contentWords(`${t.title} ${t.artist ?? ''} ${t.album ?? ''}`);
      const hits = words.filter((w) => hay.some((h) => h === w || (w.length > 3 && h.startsWith(w)))).length;
      return { t, score: hits / words.length };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.t);
}

const musicSearchTool: AgentTool = {
  name: 'music_search',
  title: 'Search the music library',
  group: 'Music',
  description: "Find songs in the listener's music library by title, artist or album (for a song request).",
  parameters: obj({ query: s('song, artist or album words') }, ['query']),
  kind: 'read',
  keywords: ['song', 'songs', 'artist', 'album', 'music', 'play'],
  available: () => OK,
  async run(args) {
    const songs = searchSongs(str(args.query, 120), await listTracks());
    return { ok: true, content: { songs: songs.map((t) => ({ track_id: t.id, title: t.title, artist: t.artist, ...(t.album ? { album: t.album } : {}) })) }, what: `Music: "${str(args.query, 40)}" (${songs.length} found)` };
  },
};

export function lookupTools(): AgentTool[] {
  return [...(Object.keys(TOOL_SPECS) as ToolName[]).map(lookupTool), calendarDayTool, googleTasksTool, musicSearchTool];
}
