// MCP tools for AI apps (ChatGPT, Claude, Grok, Meta AI ...): read what is on air, pass notes and segments to the
// hosts. Everything lands in the user's inbox; the radio picks it up in the next break.
import { addInboxItem, getUserState } from '../routes/inbox.js';
import { readDoc } from '../routes/sync.js';

export class ToolInputError extends Error {}

const text = (v, field, max, required = true) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolInputError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolInputError(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new ToolInputError(`${field} is required`);
  if (s.length > max) throw new ToolInputError(`${field} must be at most ${max} characters`);
  return s;
};

function parseUntil(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolInputError('until must be an ISO date or date-time');
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T23:59:59`) : Date.parse(v);
  if (!Number.isFinite(t)) throw new ToolInputError('until must be an ISO date or date-time');
  if (t < Date.now()) throw new ToolInputError('until is in the past');
  return Math.min(t, Date.now() + 366 * 24 * 3600 * 1000);
}

const ok = (message, structured) => ({ content: [{ type: 'text', text: message }], ...(structured ? { structuredContent: structured } : {}) });

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const read = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'now_playing',
    title: 'Now playing',
    description: 'What the listener\'s Host-Caster radio is playing right now: station, song, artist and which hosts are on air.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run(ctx) {
      const state = getUserState(ctx.db, ctx.userId, 'now_playing');
      const v = state?.value;
      const stale = !state || Date.now() - state.updatedAt > 30 * 60 * 1000;
      if (!v?.playing || stale) return ok('Nothing is playing on Host-Caster right now.', { playing: false });
      const song = `"${v.track.title}"${v.track.artist ? ` by ${v.track.artist}` : ''}`;
      const hosts = v.hosts?.length ? ` Hosts: ${v.hosts.join(', ')}.` : '';
      const air = v.onAir && v.speaking ? ` ${v.speaking} is talking on air.` : '';
      return ok(`${v.station ? `${v.station} is playing` : 'Playing'} ${song}.${hosts}${air}`, {
        playing: true,
        station: v.station,
        track: v.track,
        hosts: v.hosts,
        updatedAt: new Date(state.updatedAt).toISOString(),
      });
    },
  },
  {
    name: 'list_hosts',
    title: 'List radio hosts',
    description: 'The AI radio hosts the listener created, with a short description of each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run(ctx) {
      const doc = readDoc(ctx.app, ctx.userId).doc;
      const hosts = (doc?.hosts ?? []).map((h) => ({ name: h.name, tagline: h.tagline ?? '', personality: String(h.personality ?? '').slice(0, 240) }));
      if (!hosts.length) return ok('No hosts are synced to this Host-Caster server yet.', { hosts: [] });
      return ok(hosts.map((h) => `${h.name}${h.tagline ? `: ${h.tagline}` : ''}`).join('\n'), { hosts });
    },
  },
  {
    name: 'send_note_to_hosts',
    title: 'Send a note to the hosts',
    description:
      'Give the radio hosts something to know or mention (a plan, a mood, good news, a reminder). They work it into the next breaks between songs until it expires (default 24 hours).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note, in plain words.', maxLength: 500 },
        until: { type: 'string', description: 'Optional ISO date or date-time after which the hosts stop mentioning it.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: write,
    run(ctx, args) {
      const note = text(args.text, 'text', 500);
      const until = parseUntil(args.until);
      addInboxItem(ctx.db, ctx.userId, { kind: 'note', payload: { text: note }, source: ctx.source, until: until ?? null });
      return ok('Note sent. The hosts will bring it up in the next break.', { queued: true });
    },
  },
  {
    name: 'queue_segment',
    title: 'Queue a radio segment',
    description:
      'Queue a short segment for the next break: a topic, a story, a summary or a shout-out for the hosts to talk about on air. Optionally name the host who should say it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the segment is about or the words to say.', maxLength: 1500 },
        hostName: { type: 'string', description: 'Optional host name (see list_hosts).', maxLength: 80 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: write,
    run(ctx, args) {
      const segment = text(args.text, 'text', 1500);
      const hostName = text(args.hostName, 'hostName', 80, false);
      addInboxItem(ctx.db, ctx.userId, { kind: 'segment', payload: { text: segment, hostName }, source: ctx.source });
      return ok(`Segment queued${hostName ? ` for ${hostName}` : ''}. It airs in the next break.`, { queued: true });
    },
  },
  {
    name: 'request_song',
    title: 'Request a song',
    description: 'Ask the station to play a song next (title and/or artist). The radio looks for it in the listener\'s music.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Song title and/or artist.', maxLength: 200 } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: write,
    run(ctx, args) {
      const query = text(args.query, 'query', 200);
      addInboxItem(ctx.db, ctx.userId, { kind: 'song_request', payload: { query }, source: ctx.source });
      return ok(`Requested "${query}". The station will try to play it soon.`, { queued: true });
    },
  },
  {
    name: 'add_life_event',
    title: 'Add a life event',
    description: 'Save a date the hosts should remember (birthday, anniversary, trip, exam). Yearly events come back every year.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What happens, e.g. "Mom\'s birthday".', maxLength: 120 },
        date: { type: 'string', description: 'YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        yearly: { type: 'boolean', description: 'Repeats every year.' },
      },
      required: ['title', 'date'],
      additionalProperties: false,
    },
    annotations: write,
    run(ctx, args) {
      const title = text(args.title, 'title', 120);
      const date = text(args.date, 'date', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00`))) {
        throw new ToolInputError('date must be YYYY-MM-DD');
      }
      if (args.yearly !== undefined && typeof args.yearly !== 'boolean') throw new ToolInputError('yearly must be true or false');
      addInboxItem(ctx.db, ctx.userId, { kind: 'life_event', payload: { title, date, yearly: Boolean(args.yearly) }, source: ctx.source });
      return ok(`Saved "${title}" on ${date}${args.yearly ? ' (every year)' : ''}.`, { saved: true });
    },
  },
];
