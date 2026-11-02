// The research desk: when an item of the listener's day is new or changed (an event in the next 36 hours, an
// invitation, an important email, a top headline), the lead host's brain looks into it in the BACKGROUND with the
// lookups and keeps a short dossier: what it is about, who, what to prepare, links found, open questions, sources.
// Kept by item and version for 7 days, shared by every station. Breaks only read dossiers (never wait for one); a
// brain-less station, or an item not researched yet, has the scripted dossier made from the item's own fields.
import { isFallback, realBrainId, resolveBrain } from '../ai/brains';
import { getHost, getProfile, getSettings, kvGet, kvSet } from '../db';
import type { Brain, ContextPacket, Dossier, Host, InboxItem, LinkRef, Settings, Station } from '../types';
import { researchItems, type ResearchItem } from './brief';
import { answerFollowUp, isFollowUpQuestion, type FollowUp } from './followup';
import { runAgent } from './loop';
import { availableTools, type ToolContext } from './tools';

const STORE = 'agent:dossiers';
const KEEP_MS = 7 * 86_400_000;
const MAX_STORED = 150;
/** research tasks per device and day (each is a few model calls) */
export const RESEARCH_PER_DAY = 60;
const COUNT = 'agent:research:count';

type Store = Record<string, Dossier>;
const id = (key: string, version: string) => `${key}@${version}`;

async function load(): Promise<Store> {
  return (await kvGet<Store>(STORE))?.value ?? {};
}

async function save(store: Store): Promise<void> {
  const now = Date.now();
  const kept = Object.values(store)
    .filter((d) => now - d.at < KEEP_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_STORED);
  await kvSet(STORE, Object.fromEntries(kept.map((d) => [id(d.key, d.version), d])));
}

export async function saveDossier(d: Dossier): Promise<void> {
  const store = await load();
  store[id(d.key, d.version)] = d;
  await save(store);
}

/** The researched dossier of an item at this version, if there is one. */
export async function dossierFor(key: string, version: string): Promise<Dossier | undefined> {
  return (await load())[id(key, version)];
}

/** The newest dossier for each key (any version): a call-in about an item that changed since still gets the facts. */
export async function latestDossiers(keys: string[]): Promise<Map<string, Dossier>> {
  const want = new Set(keys);
  const out = new Map<string, Dossier>();
  for (const d of Object.values(await load())) {
    if (!want.has(d.key)) continue;
    const prev = out.get(d.key);
    if (!prev || d.at > prev.at) out.set(d.key, d);
  }
  return out;
}

export async function allDossiers(): Promise<Dossier[]> {
  return Object.values(await load()).sort((a, b) => b.at - a.at);
}

/** For a break: the researched dossier of each item at its current version, else the scripted one. */
export async function dossiersForPacket(packet: Pick<ContextPacket, 'calendar' | 'email' | 'news'>, now = Date.now()): Promise<Dossier[]> {
  const store = await load();
  return researchItems(packet, now).map((it) => store[id(it.key, it.version)] ?? it.scripted);
}

// ---- questions from the listener's AI app (MCP inbox notes) ---------------------------------------------------------

const ANSWERS = 'agent:answers';
/** an inbox question waits this long for its answer before it airs without one */
export const INBOX_ANSWER_WAIT_MS = 3 * 60_000;

export async function inboxAnswers(): Promise<Record<string, FollowUp>> {
  return (await kvGet<Record<string, FollowUp>>(ANSWERS))?.value ?? {};
}

async function saveInboxAnswer(id: string, a: FollowUp): Promise<void> {
  const all = await inboxAnswers();
  all[id] = a;
  const keep = Object.entries(all).slice(-100);
  await kvSet(ANSWERS, Object.fromEntries(keep));
}

export const isInboxQuestion = (i: InboxItem) => i.kind === 'note' && isFollowUpQuestion(i.text);

/**
 * The inbox as a break may use it: questions carry their answer; a question still being looked into waits (up to
 * INBOX_ANSWER_WAIT_MS) so it airs with its answer.
 */
export async function inboxForBreak(inbox: InboxItem[] | undefined, now = Date.now()): Promise<{ inbox?: InboxItem[]; answers: Record<string, FollowUp> }> {
  if (!inbox?.length) return { inbox, answers: {} };
  const answers = await inboxAnswers();
  const ready = inbox.filter((i) => !isInboxQuestion(i) || answers[i.id] || now - i.createdAt > INBOX_ANSWER_WAIT_MS);
  return { inbox: ready.length ? ready : undefined, answers: Object.fromEntries(ready.filter((i) => answers[i.id]).map((i) => [i.id, answers[i.id]!])) };
}

// ---- may the hosts look things up ---------------------------------------------------------------------------------

/** The listener's switch (on unless turned off) and a real AI brain. */
export function lookupsOn(settings: Pick<Settings, 'connections'>, brain: Brain | undefined): boolean {
  if (settings.connections.lookups?.enabled === false) return false;
  return Boolean(brain && !isFallback(brain) && brain.kind !== 'connector' && brain.kind !== 'builtin');
}

/** The station's lead host with a real AI brain, and that brain. */
export async function leadWithBrain(station: Station): Promise<{ host: Host; brain: Brain } | undefined> {
  for (const hid of station.hostIds.slice(0, 4)) {
    const host = await getHost(hid);
    const bid = realBrainId(host?.brainId);
    if (!host || !bid) continue;
    const brain = await resolveBrain(bid);
    if (!isFallback(brain) && brain.kind !== 'connector') return { host, brain };
  }
  return undefined;
}

export async function toolContext(settings: Settings, packet: Pick<ContextPacket, 'news'>, host: Host | undefined, purpose: ToolContext['purpose']): Promise<ToolContext> {
  const profile = await getProfile();
  return { connections: settings.connections, place: profile.location, units: profile.units, headlines: packet.news ?? [], host: host?.name, purpose };
}

// ---- the dossier a model writes --------------------------------------------------------------------------------

const strs = (v: unknown, n: number, max: number): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [])
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x).filter((y) => typeof y === 'string').join(', ') : ''))
    .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, max))
    .filter(Boolean)
    .slice(0, n);

/**
 * The model's answer as a dossier. Links are kept only when they appear in what the model was given or found
 * (no invented addresses); everything is capped.
 */
export function dossierFrom(raw: unknown, item: ResearchItem, evidence: string, extra: Partial<Dossier>): Dossier | undefined {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const about = typeof j.about === 'string' ? j.about.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  if (!about) return undefined;
  const links: LinkRef[] = (Array.isArray(j.links) ? j.links : [])
    .map((l) => (typeof l === 'string' ? { url: l } : (l as { url?: unknown; label?: unknown })))
    .filter((l): l is { url: string; label?: unknown } => typeof l?.url === 'string' && /^https?:\/\//.test(l.url) && evidence.includes(l.url))
    .slice(0, 5)
    .map((l) => ({ url: l.url, ...(typeof l.label === 'string' && l.label.trim() ? { label: l.label.trim().slice(0, 80) } : {}) }));
  // the listener is not a guest of their own day ("Me (listener)")
  const who = strs(j.who, 10, 120).filter((w) => !/^(me|you|i|the listener|listener)\b/i.test(w));
  const prepare = strs(j.prepare, 5, 200);
  const questions = strs(j.questions, 4, 200);
  return {
    ...item.scripted,
    about,
    ...(who.length ? { who } : { who: item.scripted.who }),
    ...(prepare.length ? { prepare } : {}),
    links: links.length ? links : (item.scripted.links ?? []),
    ...(questions.length ? { questions } : {}),
    by: 'ai',
    ...extra,
  };
}

export function researchPrompt(listener: string, hostName: string, item: ResearchItem, now: Date): { system: string; user: string } {
  const system = [
    `You are ${hostName}, a radio host, doing background research for your listener${listener ? ` ${listener}` : ''} before the show talks about something in their day.`,
    'Find out what the item is about, who is involved, and what the listener should prepare or know, so the hosts can mention it and answer follow-up questions later.',
    "Look things up when it helps: the event's full details, related emails, the shared notes, a linked agenda or document page, the article behind a headline. Prefer the listener's own data; use web search only for public facts.",
    'Use only what the sources say. Never invent people, numbers, times or links. If something is unknown, put it in questions.',
    'Your final answer is ONE JSON object: {"about": "one to three short plain sentences", "who": ["Name (role or answer)"], "prepare": ["short things to bring, read or decide"], "links": [{"label": "...", "url": "a link you found"}], "questions": ["what the sources did not say"]}. Leave out what you do not know.',
  ].join('\n');
  const kind = item.kind === 'calendar' ? 'CALENDAR EVENT' : item.kind === 'email' ? 'EMAIL' : 'NEWS HEADLINE';
  const user = `Now: ${now.toString().slice(0, 24)}.\n${kind} to research (what is already known):\n${item.known}`;
  return { system, user };
}

// ---- the desk -----------------------------------------------------------------------------------------------------

let preparing = 0;

/** prepareBreak marks a break being written: research waits so the brain (often one local GPU) serves the break first. */
export function markBreakPreparing(on: boolean): void {
  preparing = Math.max(0, preparing + (on ? 1 : -1));
}

async function takeQuota(): Promise<boolean> {
  const day = new Date().toDateString();
  const row = (await kvGet<{ day: string; n: number }>(COUNT))?.value;
  const n = row?.day === day ? row.n : 0;
  if (n >= RESEARCH_PER_DAY) return false;
  await kvSet(COUNT, { day, n: n + 1 });
  return true;
}

export interface DeskStatus {
  running?: string;
  queued: number;
  lastError?: string;
  done: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ResearchDesk {
  private queue: { item: ResearchItem; station: Station }[] = [];
  private running?: string;
  private failed = new Map<string, number>();
  private done = 0;
  private lastError?: string;
  private listeners = new Set<() => void>();

  status(): DeskStatus {
    return { running: this.running, queued: this.queue.length, lastError: this.lastError, done: this.done };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  /** Queues every item that has no researched dossier at its current version (fire and forget). */
  async schedule(station: Station, packet: ContextPacket): Promise<void> {
    void this.answerInbox(station, packet).catch(() => undefined);
    const settings = await getSettings();
    if (settings.connections.lookups?.enabled === false) return;
    const store = await load();
    const now = Date.now();
    for (const item of researchItems(packet, now)) {
      const key = id(item.key, item.version);
      if (store[key] || this.running === key || this.queue.some((q) => id(q.item.key, q.item.version) === key)) continue;
      // a failed item waits 30 minutes before another try
      if (now - (this.failed.get(key) ?? 0) < 30 * 60_000) continue;
      this.queue.push({ item, station });
    }
    this.queue.sort((a, b) => b.item.priority - a.item.priority);
    this.queue = this.queue.slice(0, 12);
    this.changed();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const key = id(next.item.key, next.item.version);
    this.running = key;
    this.changed();
    try {
      // never during a break's writing
      for (let i = 0; i < 60 && preparing > 0; i++) await wait(1000);
      await this.research(next.item, next.station);
      this.done++;
      this.lastError = undefined;
    } catch (err) {
      this.failed.set(key, Date.now());
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = undefined;
      this.changed();
      if (this.queue.length) setTimeout(() => void this.pump(), 1500);
    }
  }

  private answering = new Set<string>();

  /** Questions from the listener's AI app: answered in the background (lookups allowed), one at a time. */
  private async answerInbox(station: Station, packet: ContextPacket): Promise<void> {
    const done = await inboxAnswers();
    const open = (packet.inbox ?? []).filter((i) => isInboxQuestion(i) && !done[i.id] && !this.answering.has(i.id));
    for (const item of open.slice(0, 2)) {
      this.answering.add(item.id);
      try {
        for (let i = 0; i < 60 && preparing > 0; i++) await wait(1000);
        const settings = await getSettings();
        const hosts = (await Promise.all(station.hostIds.slice(0, 4).map((h) => getHost(h)))).filter((h): h is Host => Boolean(h));
        const brains = new Map<string, Brain>();
        for (const h of hosts) {
          const bid = realBrainId(h.brainId);
          if (bid && !brains.has(bid)) brains.set(bid, await resolveBrain(bid));
        }
        const a = await answerFollowUp({ said: item.text, packet, hosts, brains, settings, deadline: Date.now() + 45_000 });
        if (a) await saveInboxAnswer(item.id, a);
      } finally {
        this.answering.delete(item.id);
      }
    }
  }

  /** Researches one item now (also the "Look into it" button). Saves and returns the dossier. */
  async research(item: ResearchItem, station: Station): Promise<Dossier | undefined> {
    const lead = await leadWithBrain(station);
    const settings = await getSettings();
    if (!lead || !lookupsOn(settings, lead.brain)) return undefined;
    if (!(await takeQuota())) throw new Error(`Your hosts already researched ${RESEARCH_PER_DAY} things today`);
    const profile = await getProfile();
    const packetNews = item.kind === 'news' ? [{ id: item.key, title: item.title, source: '', url: item.scripted.links?.[0]?.url }] : [];
    const ctx = await toolContext(settings, { news: packetNews }, lead.host, 'research');
    // private items (events, mail) are researched without web search: words in an email must never steer the
    // listener's details into a search engine. A headline searches only when it has no article to read (a search
    // costs about 80 model calls on Host-Caster AI); questions the listener asks still may.
    const tools = (await availableTools({ connections: settings.connections, headlines: packetNews })).filter(
      (t) => t !== 'web_search' || (item.kind === 'news' && !packetNews[0]?.url),
    );
    const { system, user } = researchPrompt(profile.callMe || profile.name.split(' ')[0] || '', lead.host.name, item, new Date());
    const local = lead.brain.kind === 'openai' && lead.brain.transport !== 'server' && /localhost|127\.|10\.|192\.168\.|100\./.test(lead.brain.baseUrl ?? '');
    const res = await runAgent({
      brain: lead.brain,
      system,
      user,
      tools,
      ctx,
      maxSteps: 4,
      maxCalls: 5,
      deadline: Date.now() + (local ? 120_000 : 60_000),
      answer: 'json',
      maxTokens: 600,
    });
    const evidence = `${item.known}\n${res.calls.map((c) => c.content).join('\n')}`;
    const sources = [...new Set([...(item.scripted.sources ?? []), ...res.calls.filter((c) => c.ok).map((c) => c.what)])].slice(0, 8);
    const d = dossierFrom(res.json, item, evidence, { sources, hostName: lead.host.name, brainName: lead.brain.name, at: Date.now(), ms: res.ms, steps: res.steps });
    if (!d) throw new Error('The brain did not write a dossier');
    await saveDossier(d);
    return d;
  }
}

export const researchDesk = new ResearchDesk();

if (typeof window !== 'undefined') {
  // for checks from the browser (e2e): the desk and the dossiers
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  const g = (w.__hostcaster ??= {});
  g.agent = { ...((g.agent as object) ?? {}), researchDesk, allDossiers, dossiersForPacket, inboxAnswers };
  // test builds: plant a dossier (the tracker e2e checks what a holiday's to-dos become)
  if (import.meta.env.VITE_HOSTCASTER_DEBUG === '1') (g.agent as Record<string, unknown>).saveDossier = saveDossier;
  // test builds on the web: the device database too (the phone shell exposes it the same way)
  if (import.meta.env.VITE_HOSTCASTER_DEBUG === '1') void import('../db').then((db) => Object.assign((w.__hostcaster ??= {}), { db }));
}
