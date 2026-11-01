// The hosts write to Notion only when the listener asks: a call-in, or their AI app through the inbox. The station's
// brain reads the ask into one fixed action (add a to-do / add a note / none); without a brain, or when its answer
// does not check out, the offline reader decides. The server appends one block and logs it; the break says so.
import { isFallback, resolveBrain } from '../ai/brains';
import { generate } from '../ai/generate';
import { extractJson } from '../ai/json';
import { api, ApiError } from '../api/client';
import { notion } from '../api/notion';
import { getInbox, markInboxUsed } from '../context/sources';
import { getSettings, kvGet, kvSet, listBreaks } from '../db';
import type { Brain, InboxItem, Station } from '../types';
import { ASK_SYSTEM, checkAsk, mightAskToWrite, parseAskOffline, spokenProblem, type NotionAsk, type NotionWrite } from './notionAsk';
import { loadLineup } from './prepare';

const BRAIN_TIMEOUT_MS = 12_000;

/** The station's brain for reading asks: the first host with a real model (not the scripted fallback, not an AI app). */
export async function stationBrain(station: Station): Promise<Brain | undefined> {
  for (const host of await loadLineup(station)) {
    const brain = await resolveBrain(host.brainId).catch(() => undefined);
    if (brain && !isFallback(brain) && brain.kind !== 'connector') return brain;
  }
  return undefined;
}

/** What the listener asked to add, or undefined (not an ask). The brain first, the offline reader as the safe fallback. */
export async function understandAsk(said: string, brain?: Brain, signal?: AbortSignal): Promise<NotionAsk | undefined> {
  if (!mightAskToWrite(said)) return undefined;
  if (brain) {
    try {
      const raw = await generate(brain, { system: ASK_SYSTEM, messages: [{ role: 'user', content: said.slice(0, 1200) }], json: true, maxTokens: 160 }, { signal, timeoutMs: BRAIN_TIMEOUT_MS });
      const checked = checkAsk(extractJson(raw), said);
      if (checked === 'none') return undefined;
      if (checked) return checked;
    } catch (err) {
      if (signal?.aborted) throw err;
      // the brain is out of reach or slow: the offline reader decides
    }
  }
  return parseAskOffline(said);
}

const connectedHere = async () => Boolean((await getSettings()).connections.notion?.connected);

/** Sends one ask to the server; never throws (a failure becomes words the hosts can say). */
export async function sendAsk(ask: NotionAsk, from: 'call' | 'app', ref?: string): Promise<NotionWrite> {
  if (!api.available || !api.signedIn) return { ...ask, from, ok: false, problem: spokenProblem('offline') };
  try {
    const r = await notion.write({ kind: ask.kind, text: ask.text, source: from, ref });
    return r.ok ? { ...ask, from, ok: true, pageTitle: r.pageTitle } : { ...ask, from, ok: false, problem: spokenProblem(r.code) };
  } catch (err) {
    return { ...ask, from, ok: false, problem: spokenProblem(err instanceof ApiError ? err.code : undefined) };
  }
}

/**
 * A call-in: when the listener asked to put something in Notion, add it now so the answer can confirm it. Not
 * connected: only an ask that names Notion gets an answer (how to connect it); other words stay a normal call.
 */
export async function takeNotionWrite(said: string, station: Station, signal?: AbortSignal): Promise<NotionWrite | undefined> {
  if (!mightAskToWrite(said)) return undefined;
  if (!(await connectedHere())) {
    const ask = /\bnotion\b/i.test(said) ? parseAskOffline(said) : undefined;
    return ask ? { ...ask, from: 'call', ok: false, problem: spokenProblem('not_configured') } : undefined;
  }
  const ask = await understandAsk(said, await stationBrain(station), signal);
  return ask ? sendAsk(ask, 'call') : undefined;
}

/** The oldest AI-app note or segment that asks to add something to Notion: written once (by ref) and used up. */
export async function nextInboxNotionWrite(station: Station): Promise<NotionWrite | undefined> {
  if (!(await connectedHere())) return undefined;
  const settings = await getSettings();
  const items = await getInbox(settings.connections.aiApps?.enabled !== false);
  const candidates = items.filter((i: InboxItem) => (i.kind === 'note' || i.kind === 'segment') && mightAskToWrite(i.text));
  if (!candidates.length) return undefined;
  const brain = await stationBrain(station);
  for (const item of candidates.slice(0, 2)) {
    const ask = await understandAsk(item.text, brain);
    if (!ask) continue;
    await markInboxUsed([item.id]);
    return sendAsk(ask, 'app', `inbox:${item.id}`);
  }
  return undefined;
}

// ---- daily recap (off by default; the listener turns it on in Settings) -----------------------------------------------

const RECAP_KEY = 'notion:recap';
const RECAP_HOUR = 21;

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A short note about the day on air: breaks, the songs the hosts named, what went into Notion. */
export async function recapText(station: Station, now = Date.now()): Promise<string | undefined> {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const today = (await listBreaks(station.id, 300)).filter((b) => b.at >= start);
  if (!today.length) return undefined;
  const songs = [...new Set(today.flatMap((b) => [b.songBefore, b.songAfter]).filter(Boolean).map((s) => `${s!.title}${s!.artist ? ` by ${s!.artist}` : ''}`))];
  const parts = [`Today on ${station.name}: ${today.length} break${today.length === 1 ? '' : 's'}.`];
  if (songs.length) parts.push(`Songs the hosts talked about: ${songs.slice(0, 8).join('; ')}${songs.length > 8 ? `, and ${songs.length - 8} more` : ''}.`);
  return parts.join(' ').slice(0, 900);
}

/** After a break: once a day, late in the evening, adds the recap when the listener turned it on. */
export async function maybeNotionRecap(station: Station, now = Date.now()): Promise<void> {
  if (new Date(now).getHours() < RECAP_HOUR || !api.available || !api.signedIn || !(await connectedHere())) return;
  const day = dayOf(now);
  const last = (await kvGet<{ day: string; done: boolean; at: number }>(RECAP_KEY))?.value;
  if (last?.day === day && (last.done || now - last.at < 3600_000)) return;
  const text = await recapText(station, now);
  if (!text) return;
  try {
    const r = await notion.recap(day, text);
    await kvSet(RECAP_KEY, { day, done: r.ok || r.code === 'recap_done', at: now });
  } catch {
    await kvSet(RECAP_KEY, { day, done: false, at: now });
  }
}
