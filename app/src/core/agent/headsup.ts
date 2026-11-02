// Heads-ups: while the radio plays, the listener's calendar and mail are checked every few minutes with cheap change
// requests (Google's "changed since", Gmail's history, each calendar feed), compared with what the hosts last knew,
// and anything important that changed gets a short researched note and goes on air ONCE. core/radio/radio.ts decides
// how: over the music now, right after the song, or first in the next break (core/agent/changes.ts deliveryFor).
import { generate } from '../ai/generate';
import { api, integrations, request } from '../api';
import { parseIcs } from '../context/ics';
import { fetchText } from '../context/sources';
import { getProfile, getSettings, kvGet, kvSet } from '../db';
import type { CalendarEvent, Connections, EmailSummary, HeadsUp, Station } from '../types';
import { runAgent } from './loop';
import { latestDossiers, leadWithBrain, lookupsOn, toolContext } from './research';
import { availableTools } from './tools';
import {
  applyChanges,
  diffCalendar,
  feedChanges,
  mailByRules,
  peopleToday,
  reminderAt,
  reminderHeadsUp,
  urgentMailHeadsUp,
  type WatchedEvent,
  type WatchedMail,
} from './changes';

/** a check while the radio plays, about every two and a half minutes */
export const WATCH_EVERY_MS = 150_000;
/** feeds (ICS) and IMAP cost a whole download each: every other check */
const SLOW_EVERY = 2;
/** a snapshot older than this is not what the hosts "last knew": start over from now instead of telling old changes */
const BASELINE_MAX_AGE_MS = 30 * 60_000;
/** kept for Settings and dedupe */
const KEEP_MS = 48 * 3_600_000;
const STORE = 'headsups';
const NOTES_PER_DAY = 40;
const NOTE_COUNT = 'headsups:notes';
const HOURS = 36;

// ------------------------------------------------------------------------------------------------ the store

let lock: Promise<unknown> = Promise.resolve();
const locked = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
};

/** Every heads-up of the last two days, oldest first. */
export async function listHeadsUps(): Promise<HeadsUp[]> {
  return (await kvGet<HeadsUp[]>(STORE).catch(() => undefined))?.value ?? [];
}

const save = (list: HeadsUp[]) => kvSet(STORE, list.filter((h) => Date.now() - h.at < KEEP_MS).slice(-80));

/** Adds the ones never seen before (one heads-up per change, ever) and returns them. */
export function addHeadsUps(items: HeadsUp[]): Promise<HeadsUp[]> {
  return locked(async () => {
    const list = await listHeadsUps();
    const seen = new Set(list.map((h) => h.id));
    const fresh = items.filter((h) => !seen.has(h.id) && (seen.add(h.id), true));
    if (fresh.length) await save([...list, ...fresh]);
    return fresh;
  });
}

export function updateHeadsUp(id: string, patch: Partial<HeadsUp>): Promise<void> {
  return locked(async () => {
    const list = await listHeadsUps();
    await save(list.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  });
}

/** Told on air: never again. */
export function markAired(ids: string[], via: HeadsUp['via'], said?: string): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return locked(async () => {
    const now = Date.now();
    const list = await listHeadsUps();
    await save(list.map((h) => (ids.includes(h.id) && h.state === 'pending' ? { ...h, state: 'aired', airedAt: now, via, ...(said ? { said } : {}) } : h)));
  });
}

/** in-memory: heads-ups going on air right now (a break-in), so a break being written leaves them out */
const inFlight = new Set<string>();
export const claim = (id: string) => (inFlight.has(id) ? false : (inFlight.add(id), true));
export const release = (id: string) => void inFlight.delete(id);

/** Waiting to be told: not older than 3 hours, a reminder or a change about an event that has not started yet. */
export async function pendingHeadsUps(now = Date.now()): Promise<HeadsUp[]> {
  return (await listHeadsUps()).filter(
    (h) => h.state === 'pending' && !inFlight.has(h.id) && now - h.at < 3 * 3_600_000 && !(h.kind === 'reminder' && (h.start ?? 0) < now) && !(h.kind !== 'cancelled' && h.start && h.start < now - 10 * 60_000),
  );
}

/** "got it", "thanks" on a call-in: the heads-up told in the last 15 minutes is snoozed (no reminder for it either). */
export function snoozeLast(now = Date.now()): Promise<HeadsUp | undefined> {
  return locked(async () => {
    const list = await listHeadsUps();
    const last = list.filter((h) => h.state === 'aired' && h.airedAt && now - h.airedAt < 15 * 60_000).sort((a, b) => (b.airedAt ?? 0) - (a.airedAt ?? 0))[0];
    if (!last) return undefined;
    await save(list.map((h) => (h.id === last.id ? { ...h, state: 'snoozed' } : h)));
    return { ...last, state: 'snoozed' };
  });
}

// ------------------------------------------------------------------------------------------------ notes

async function takeNote(): Promise<boolean> {
  const day = new Date().toDateString();
  const row = (await kvGet<{ day: string; n: number }>(NOTE_COUNT))?.value;
  const n = row?.day === day ? row.n : 0;
  if (n >= NOTES_PER_DAY) return false;
  await kvSet(NOTE_COUNT, { day, n: n + 1 });
  return true;
}

const LOOKUP_TOOLS = ['calendar_event', 'calendar_search', 'email_search', 'email_read', 'email_thread'];

/**
 * The short researched note (and a ready break-in line in the lead host's words): what the hosts know about the item,
 * plus a quick lookup for the reason (a cancellation email, the organizer's note). Small budget; without a brain or
 * lookups, the facts and the item's dossier.
 */
export async function noteFor(h: HeadsUp, station: Station): Promise<Pick<HeadsUp, 'note' | 'say'>> {
  const key = h.eventId ? `calendar:${h.eventId}` : h.mailId ? `email:${h.mailId}` : '';
  const d = key ? (await latestDossiers([key]).catch(() => new Map())).get(key) : undefined;
  const scripted = [h.fact, h.source ? `The notice says: ${h.source}` : '', d?.about && !h.fact.includes(d.about) ? d.about : ''].filter(Boolean).join(' ').slice(0, 500);
  if (h.kind === 'reminder') return { note: scripted };
  const lead = await leadWithBrain(station).catch(() => undefined);
  const settings = await getSettings();
  if (!lead || !lookupsOn(settings, lead.brain) || !(await takeNote())) return { note: scripted };
  const profile = await getProfile();
  const listener = profile.callMe || profile.name.split(' ')[0] || 'the listener';
  const tools = (await availableTools({ connections: settings.connections, headlines: [] })).filter((t) => LOOKUP_TOOLS.includes(t));
  const local = lead.brain.kind === 'openai' && lead.brain.transport !== 'server' && /localhost|127\.|10\.|192\.168\.|100\./.test(lead.brain.baseUrl ?? '');
  const system = [
    `You are ${lead.host.name}, a radio host. ${lead.host.personality ? `Who you are: ${lead.host.personality.trim().slice(0, 300)}` : ''}`,
    `Something important just changed in ${listener}'s day and you will tell them on air in a moment.`,
    'If it is quick, look up why (a cancellation or reschedule email, the event notes) or what to do next. Use only what the sources say; never guess a reason.',
    'The say line tells THE CHANGE first (who, what, when, as given), then a reason only if a source you read states it. Never mention what you could not find or verify, and never talk about other events or emails.',
    'Answer ONE JSON object: {"say": "one or two short spoken sentences, a quick heads-up in your own voice, starting with Quick heads-up; say times as clock times (2 PM); no links, addresses, numbers or codes", "note": "one to three plain sentences: what changed, why if the sources say, what they may want to do"}.',
  ].join('\n');
  const user = `THE CHANGE: ${h.fact}\nWHY IT MATTERS: ${h.why}\n${h.source ? `THE CALENDAR'S NOTICE SAYS: ${h.source}\n` : ''}${d?.about ? `WHAT THE HOSTS KNEW: ${d.about}${d.who?.length ? ` Who: ${d.who.join(', ')}.` : ''}\n` : ''}${h.eventId ? `EVENT ID: ${h.eventId}\n` : ''}${h.mailId ? `EMAIL ID: ${h.mailId}\n` : ''}NOW: ${new Date().toString().slice(0, 21)}`;
  try {
    const ctx = await toolContext(settings, { news: [] }, lead.host, 'research');
    const res = await runAgent({ brain: lead.brain, system, user, tools, ctx, maxSteps: 3, maxCalls: 2, deadline: Date.now() + (local ? 25_000 : 12_000), answer: 'json', maxTokens: 300 });
    const j = (res.json && typeof res.json === 'object' ? res.json : {}) as Record<string, unknown>;
    const clean = (v: unknown, n: number) =>
      typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s*[\u2014\u2013]\s*/g, ', ').trim().slice(0, n) : '';
    const say = clean(j.say, 260).replace(/^(quick heads[- ]up)\s*[;,:.!-]?\s*/i, 'Quick heads-up: ');
    const note = clean(j.note, 420);
    return { note: note || scripted, ...(say && onTopic(say, h) ? { say } : {}) };
  } catch {
    return { note: scripted };
  }
}

/**
 * A brain-written line goes on air only when it tells this change (the sender, or a word of the title) and does not
 * wander (what it could not find, an address or a long number): else the scripted line does.
 */
export function onTopic(say: string, h: Pick<HeadsUp, 'kind' | 'title' | 'fact'>): boolean {
  const s = say.toLowerCase();
  if (/@|\d{4,}|\b(couldn'?t|could not|can'?t|cannot|unable to) (verify|find|confirm|see)\b|\bnot sure\b/i.test(say)) return false;
  const sender = /from ([A-Z][\w'-]+)/.exec(h.fact)?.[1]?.toLowerCase();
  const words = h.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['urgent', 'about', 'meeting', 'event', 'with'].includes(w));
  return h.kind === 'urgent' ? Boolean(sender && s.includes(sender)) : words.some((w) => s.includes(w));
}

/** Is a new message urgent? The brain judges the ones that might be (the rules alone without a brain). */
export async function judgeMail(m: WatchedMail, meetToday: string[], station: Station): Promise<{ urgent: boolean; why: string; gist?: string }> {
  const rules = mailByRules(m, meetToday);
  if (!rules.candidate) return rules;
  const lead = await leadWithBrain(station).catch(() => undefined);
  if (!lead) return rules;
  const system = [
    'You decide if an email that just arrived is urgent enough to interrupt the radio the listener is playing.',
    'Urgent means ALL of: a real person wrote it (not a newsletter, promotion, notification or automatic message), it is time-sensitive, and it asks the listener to act today or is about a meeting today.',
    'Marketing words like "urgent", "last chance" or "act now" never count.',
    'Answer JSON only: {"urgent": true or false, "why": "a few words", "gist": "what it asks, under 12 words, no addresses, links or numbers"}',
  ].join('\n');
  const hints = [m.reply ? 'a reply in a conversation the listener is in' : '', meetToday.includes(m.from.split(/\s+/)[0]!.toLowerCase()) ? 'the sender is in a meeting with the listener today' : '', m.gmailImportant ? 'Gmail marked it important' : '']
    .filter(Boolean)
    .join('; ');
  const user = `FROM: ${m.from}\nSUBJECT: ${m.subject}\nTEXT: ${(m.body || m.snippet || '').slice(0, 600)}${hints ? `\nHINTS: ${hints}` : ''}`;
  try {
    const raw = await generate(lead.brain, { system, messages: [{ role: 'user', content: user }], json: true, maxTokens: 120 }, { timeoutMs: 12_000 });
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { urgent?: unknown; why?: unknown; gist?: unknown };
    if (typeof j.urgent !== 'boolean') return rules;
    const gist = typeof j.gist === 'string' ? j.gist.replace(/https?:\/\/\S+|\S+@\S+/g, '').trim().slice(0, 100) : undefined;
    return { urgent: j.urgent, why: `Urgent email (judged by ${lead.brain.name}): ${typeof j.why === 'string' ? j.why.slice(0, 120) : rules.why}`, ...(gist ? { gist } : {}) };
  } catch {
    return rules;
  }
}

// ------------------------------------------------------------------------------------------------ the watch

export interface WatchHooks {
  /** the radio is playing (quiet when paused) */
  playing(): boolean;
  /** a heads-up to put on air (urgent ones and reminders; the others wait for the next break) */
  deliver(h: HeadsUp): Promise<void> | void;
}

export interface WatchStatus {
  on: boolean;
  lastCheck?: number;
  checks: number;
  lastError?: string;
  /** when the next check is due */
  nextAt?: number;
}

const isRateLimited = (err: unknown) => (err as { status?: number }).status === 429 || /rate|slow down|too many/i.test(String((err as Error)?.message));

class HeadsUpWatch {
  private session = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private station?: Station;
  private hooks?: WatchHooks;
  private known: CalendarEvent[] = [];
  private feeds = new Map<string, CalendarEvent[]>();
  private since = 0;
  private historyId?: string;
  private imapSeen?: Set<string>;
  private baselined = false;
  private ticks = 0;
  private reminders = new Map<string, ReturnType<typeof setTimeout>>();
  private running?: Promise<void>;
  private _status: WatchStatus = { on: false, checks: 0 };

  status(): WatchStatus {
    return this._status;
  }

  start(station: Station, hooks: WatchHooks, firstMs = 20_000): void {
    this.stop();
    this.station = station;
    this.hooks = hooks;
    this.baselined = false;
    this.ticks = 0;
    this._status = { on: true, checks: 0 };
    const s = ++this.session;
    this.timer = setTimeout(() => void this.tick(s), firstMs);
  }

  stop(): void {
    this.session++;
    if (this.timer) clearTimeout(this.timer);
    this.reminders.forEach((t) => clearTimeout(t));
    this.reminders.clear();
    this.station = undefined;
    this._status = { ...this._status, on: false };
  }

  /** A check now (tests, the e2e), whatever the timer says. */
  async checkNow(): Promise<void> {
    if (this.station) await this.run();
  }

  private async tick(s: number): Promise<void> {
    if (s !== this.session) return;
    let next = WATCH_EVERY_MS + Math.round((Math.random() - 0.5) * 20_000);
    try {
      if (this.hooks?.playing()) await this.run();
    } catch (err) {
      this._status = { ...this._status, lastError: err instanceof Error ? err.message : String(err) };
      // the server or Google asked to slow down: wait longer
      if (isRateLimited(err)) next = 10 * 60_000;
    }
    if (s !== this.session) return;
    this._status = { ...this._status, nextAt: Date.now() + next };
    this.timer = setTimeout(() => void this.tick(s), next);
  }

  private run(): Promise<void> {
    this.running ??= this.check().finally(() => (this.running = undefined));
    return this.running;
  }

  private async check(): Promise<void> {
    const station = this.station;
    if (!station) return;
    const s = this.session;
    const settings = await getSettings();
    const conn = settings.connections;
    const seg = station.segments;
    const now = Date.now();
    const slow = this.ticks++ % SLOW_EVERY === 0;
    const found: HeadsUp[] = [];
    const notices: WatchedMail[] = [];
    if (!this.baselined) await this.baseline(conn, now);
    const online = api.available && api.signedIn;
    const wantCal = seg.calendar && conn.calendar?.google;
    const wantGmail = seg.email && conn.email?.gmail;
    if (online && (wantCal || wantGmail)) {
      const w = await integrations.watch({ since: this.since, historyId: this.historyId });
      if (w.calendar && wantCal) {
        const changed = w.calendar.changed as WatchedEvent[];
        const google = this.known.filter((e) => e.source === 'google');
        found.push(...diffCalendar(google, changed, now));
        this.known = applyChanges(this.known, changed);
        this.since = w.calendar.checkedAt;
        if (changed.length) await patchCache<CalendarEvent>('calendar:google', (list) => applyChanges(list, changed));
      }
      if (w.gmail) {
        const fresh = w.gmail.messages as WatchedMail[];
        notices.push(...fresh);
        if (this.historyId && wantGmail && fresh.length) found.push(...(await this.urgentOf(fresh, station, now)));
        this.historyId = w.gmail.historyId;
        const real = fresh.filter((m) => !m.bulk);
        if (real.length) await patchCache<EmailSummary>('email:gmail', (list) => [...real.map(plainMail), ...list.filter((x) => !real.some((m) => m.id === x.id))].slice(0, 10));
      }
    }
    if (slow && seg.calendar) {
      for (const url of conn.calendar?.icsUrls ?? []) {
        const text = await fetchText(url).catch(() => undefined);
        if (!text) continue;
        const fresh = parseIcs(text, now - 3_600_000, now + HOURS * 3_600_000);
        const old = this.feeds.get(url);
        if (old) {
          const changed = feedChanges(old, fresh, now);
          found.push(...diffCalendar(old, changed, now));
        }
        this.feeds.set(url, fresh);
        await kvSet(`calendar:ics:${url}`, text).catch(() => undefined);
      }
    }
    if (slow && seg.email && conn.email?.imap && online) {
      const msgs = (await request<{ messages: EmailSummary[] }>('GET', '/api/imap/summary?max=10').catch(() => undefined))?.messages;
      if (msgs) {
        const fresh = msgs.filter((m) => !this.imapSeen?.has(m.id));
        if (this.imapSeen && fresh.length) found.push(...(await this.urgentOf(fresh, station, now)));
        this.imapSeen = new Set(msgs.map((m) => m.id));
      }
    }
    if (s !== this.session) return;
    // the calendar's own notice of a cancellation or a move (it says why, in the organizer's words)
    for (const h of found) if (h.eventId && (h.kind === 'cancelled' || h.kind === 'moved')) h.source = noticeFor(h.title, notices);
    this.scheduleReminders(settings.connections.headsUps?.remindMin ?? 10, now);
    // a few at a time: one burst of changes is not a dozen interruptions
    const added = await addHeadsUps(found.slice(0, 4));
    this._status = { ...this._status, on: true, lastCheck: now, checks: this._status.checks + 1, lastError: undefined };
    for (const h of added) await this.enrichAndDeliver(h, s);
    // urgent ones still waiting (the radio was paused, the song was ending): try again
    for (const h of await pendingHeadsUps()) if ((h.major || h.kind === 'reminder') && !added.some((a) => a.id === h.id) && s === this.session) await this.hooks?.deliver(h);
  }

  /** What the hosts last knew: the calendar and mail snapshots the breaks read (if recent), else a fresh look now. */
  private async baseline(conn: Connections, now: number): Promise<void> {
    this.baselined = true;
    const cal = await kvGet<CalendarEvent[]>('calendar:google').catch(() => undefined);
    if (cal?.value && now - cal.fetchedAt < BASELINE_MAX_AGE_MS) {
      this.known = cal.value;
      this.since = cal.fetchedAt;
    } else if (conn.calendar?.google && api.available && api.signedIn) {
      const events = (await integrations.calendar(HOURS).catch(() => undefined))?.events as CalendarEvent[] | undefined;
      if (events) await kvSet('calendar:google', events, now).catch(() => undefined);
      this.known = events ?? [];
      this.since = now;
    } else this.since = now;
    for (const url of conn.calendar?.icsUrls ?? []) {
      const c = await kvGet<string>(`calendar:ics:${url}`).catch(() => undefined);
      if (c?.value && now - c.fetchedAt < BASELINE_MAX_AGE_MS) this.feeds.set(url, parseIcs(c.value, now - 3_600_000, now + HOURS * 3_600_000));
    }
    const imap = await kvGet<EmailSummary[]>('email:imap').catch(() => undefined);
    if (imap?.value && now - imap.fetchedAt < BASELINE_MAX_AGE_MS) this.imapSeen = new Set(imap.value.map((m) => m.id));
  }

  private async urgentOf(msgs: WatchedMail[], station: Station, now: number): Promise<HeadsUp[]> {
    const meet = peopleToday([...this.known, ...[...this.feeds.values()].flat()], now);
    const out: HeadsUp[] = [];
    for (const m of msgs.slice(0, 5)) {
      const j = await judgeMail(m, meet, station);
      if (j.urgent) out.push(urgentMailHeadsUp(m, j.why, now, j.gist));
    }
    return out;
  }

  private async enrichAndDeliver(h: HeadsUp, s: number): Promise<void> {
    const station = this.station;
    if (!station) return;
    const extra = await noteFor(h, station).catch(() => ({}));
    const full = { ...h, ...extra };
    await updateHeadsUp(h.id, extra);
    if (s === this.session && (full.major || full.kind === 'reminder')) await this.hooks?.deliver(full);
  }

  /** Reminders: a timer for each meeting with guests or a video call whose reminder falls before the next check. */
  private scheduleReminders(remindMin: number, now: number): void {
    if (!remindMin || !this.station?.segments.calendar) return;
    const events = [...this.known, ...[...this.feeds.values()].flat()];
    const live = new Set<string>();
    for (const e of events) {
      const at = reminderAt(e, remindMin, now, WATCH_EVERY_MS + 60_000);
      const key = `reminder:${e.id}:${e.start}`;
      live.add(key);
      if (at === undefined || this.reminders.has(key)) continue;
      const s = this.session;
      this.reminders.set(
        key,
        setTimeout(() => void this.fireReminder(e, s), Math.max(0, at - Date.now())),
      );
    }
    // moved or cancelled meetings lose their old reminder
    for (const [key, t] of this.reminders) {
      if (!live.has(key)) {
        clearTimeout(t);
        this.reminders.delete(key);
      }
    }
  }

  private async fireReminder(e: CalendarEvent, s: number): Promise<void> {
    if (s !== this.session) return;
    const now = Date.now();
    const list = await listHeadsUps();
    // snoozed ("got it"), or a heads-up about it in the last quarter hour: no reminder on top
    if (list.some((h) => h.eventId === e.id && (h.state === 'snoozed' || (h.airedAt && now - h.airedAt < 15 * 60_000) || h.kind === 'cancelled'))) return;
    const d = (await latestDossiers([`calendar:${e.id}`]).catch(() => new Map())).get(`calendar:${e.id}`);
    const [h] = await addHeadsUps([reminderHeadsUp(e, d?.prepare, now)]);
    if (h) await this.enrichAndDeliver(h, s);
  }
}

/** The organizer's note in a calendar notice about `title` ("Canceled event: Q4 budget review ... Note from the organizer: ..."). */
export function noticeFor(title: string, mails: Pick<EmailSummary, 'subject' | 'body' | 'snippet'>[]): string | undefined {
  const t = title.toLowerCase();
  const m = mails.find((x) => x.subject.toLowerCase().includes(t) && /cancel|updated|changed|moved|reschedul/i.test(x.subject));
  const text = (m?.body || m?.snippet || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const note = /(?:note from the organizer|message from the organizer|organizer'?s note)\s*:?\s*(.+)/i.exec(text)?.[1] ?? text;
  return note.replace(/https?:\/\/\S+|\S+@\S+/g, '').slice(0, 300).trim() || undefined;
}

/** Updates a source's snapshot in place (its fetch time kept: the regular refresh still happens). */
async function patchCache<T>(key: string, fn: (list: T[]) => T[]): Promise<void> {
  const c = await kvGet<T[]>(key).catch(() => undefined);
  if (c?.value) await kvSet(key, fn(c.value), c.fetchedAt).catch(() => undefined);
}

const plainMail = (m: WatchedMail): EmailSummary => {
  const { bulk: _b, reply: _r, gmailImportant, starred: _s, address: _a, ...rest } = m;
  return { ...rest, important: rest.important || Boolean(gmailImportant) };
};

export const headsUpWatch = new HeadsUpWatch();

if (typeof window !== 'undefined') {
  // for checks from the browser (e2e): the watch and the heads-ups
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  const g = (w.__hostcaster ??= {});
  g.agent = { ...((g.agent as object) ?? {}), headsUpWatch, listHeadsUps };
}
