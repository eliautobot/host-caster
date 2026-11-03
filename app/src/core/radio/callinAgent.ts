// An on-air call-in with an AI brain: one agent turn (agent/kit, docs/AGENT.md) before the break is written. The lead
// host does what the listener asked with the tools (Your list, memory, a song, Google, Notion) or looks it up, and
// writes the answer; the break then airs it, and code's exact line (a done line or the read-back that waits for a
// yes) closes the break. Without an AI brain the radio keeps its plain command reader (radio.ts).
import { callFacts } from '../call/brain';
import { effectsTurn } from '../agent/kit/effects';
import { agentTurn } from '../agent/kit/turn';
import type { Effect, MusicHooks } from '../agent/kit/types';
import { followItems, followUpPrompt, isFollowUpQuestion, type FollowUp } from '../agent/followup';
import { toolContext } from '../agent/research';
import { stationHost } from './notionWrite';
import type { ActionTurn } from '../actions/callin';
import { buildContext } from '../context/context';
import { db } from '../db/db';
import { getProfile, getSettings } from '../db';
import type { MemoryChange } from '../memory/commands';
import { cardLine, MEMORY_RULE, pickCards } from '../memory/brief';
import { listBrief, listSheet, LIST_RULE } from '../tracker/brief';
import { speakable } from '../tracker/safety';
import type { Station } from '../types';
import type { NotionWrite } from './notionAsk';
import type { SongRequest } from './requests';

export interface CallInTurn {
  /** the agent's answer, when it did something or looked something up, or the listener asked (else the break reacts) */
  answer?: FollowUp;
  action?: ActionTurn;
  request?: SongRequest;
  memory?: MemoryChange;
  notion?: NotionWrite;
}

const DEADLINE_MS = 22_000;

const first = <K extends Effect['kind']>(effects: Effect[], kind: K) => effects.find((e): e is Extract<Effect, { kind: K }> => e.kind === kind);

/** undefined: no host with a real AI brain (the scripted reader answers), or an AI app's brain (words only). */
export async function callInTurn(station: Station, said: string, opts: { music?: MusicHooks; signal?: AbortSignal; onLookup?: () => void } = {}): Promise<CallInTurn | undefined> {
  const lead = await stationHost(station).catch(() => undefined);
  if (!lead) return undefined;
  const t0 = Date.now();
  const settings = await getSettings();
  const profile = await getProfile();
  const listener = profile.callMe || profile.name || 'the listener';
  const packet = await buildContext(station, {}, { budgetMs: 5000 }).catch(() => undefined);
  const items = packet ? await followItems(packet).catch(() => []) : [];
  const cards = await db.memories.toArray().catch(() => []);
  const memory = pickCards(cards, { topics: '', callIn: said, now: t0, max: 6, budget: 600 }).map(cardLine);
  const list = await listBrief({ now: t0, callIn: true }).catch(() => undefined);
  const system = [
    `You are ${lead.host.name}, a host on the radio station ${station.name}. ${listener} just called in, live on the air.`,
    'First do what they ask with your tools, or look up what they ask about. Then write what the hosts will say back on air: one to three short plain sentences, true to your tools and the facts. No lists, no markdown, no name labels, no em dashes.',
    'When they only tell you something (news, a shout-out, how their day is going), use no tools and just react to it in one warm line.',
    'Never make up facts, times or names: if you cannot find it, say so plainly. Never read out links, email addresses, phone numbers or codes.',
    MEMORY_RULE,
    LIST_RULE,
  ].join('\n');
  const user = [
    `LISTENER: ${listener}${packet?.listener.about ? `. ${speakable(packet.listener.about, 200)}` : ''}`,
    // what aired lately in full (heads-ups with their notes, events, mail, headlines), as the follow-up answers had it
    followUpPrompt(lead.host.name, said, items, t0, memory).user,
    ...(packet ? callFacts(packet, items, t0).filter((f) => !f.startsWith('LAST ON AIR')) : []),
    listSheet(list),
    `${listener.toUpperCase()} SAID ON THE AIR: "${said}"`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const res = await agentTurn({
    turn: 'call-in',
    brain: lead.brain,
    system,
    user,
    said,
    heard: said,
    ctx: await toolContext(settings, { news: packet?.news ?? [] }, lead.host, 'call-in'),
    music: opts.music,
    maxSteps: 4,
    maxCalls: 5,
    deadline: t0 + DEADLINE_MS,
    maxTokens: 400,
    signal: opts.signal,
    onLookup: () => opts.onLookup?.(),
  });
  const text = res.text.replace(/\s+/g, ' ').trim();
  const action = await effectsTurn(res.effects).catch(() => undefined);
  // a statement the agent only reacted to: the break writer reacts to the call itself, as for any call-in
  const useful = Boolean(text) && (res.calls.length > 0 || isFollowUpQuestion(said));
  return {
    ...(useful ? { answer: { question: said, answer: text.slice(0, 700), found: true, sources: res.calls.filter((c) => c.ok).map((c) => c.what), by: 'ai' as const, ms: Date.now() - t0, lookups: res.calls.length } } : {}),
    ...(action ? { action } : {}),
    ...(first(res.effects, 'song') ? { request: first(res.effects, 'song')!.request } : {}),
    ...(first(res.effects, 'memory') ? { memory: first(res.effects, 'memory')!.change } : {}),
    ...(first(res.effects, 'notion') ? { notion: first(res.effects, 'notion')!.write } : {}),
  };
}
