// Prepares a break before it airs: context packet -> plan -> script -> voice clips. All lines are voiced at once and
// the break is ready as soon as the script and the FIRST clip are: the rest finish while the first lines play (a
// cloud voice can take many seconds per request, and that wait should not add up line after line).
import { isFallback, realBrainId, resolveBrain } from '../ai/brains';
import { generate } from '../ai/generate';
import { isLocal } from '../ai/openai';
import { buildContext, summarize } from '../context/context';
import { getHost } from '../db';
import { DEVICE_VOICE_ID, type Brain, type Break, type BreakLine, type ContextPacket, type Host, type Station, type Track, type TrackSummary, type VoiceClip } from '../types';
import { speak } from '../voice/voice';
import { writeBuiltinBreak } from './builtin';
import { planBreak, type BreakKind, type BreakPlan } from './planner';
import type { NotionWrite } from './notionAsk';
import type { SongRequest } from './requests';
import { writeBreak, writeMode, type WriteMode, type WrittenBreak } from './writer';

export interface PreparedBreak {
  station: Station;
  hosts: Host[];
  plan: BreakPlan;
  packet: ContextPacket;
  lines: BreakLine[];
  /** one per line; clips[0] is ready, later ones may still be on their way (they never reject) */
  clips: (VoiceClip | Promise<VoiceClip>)[];
  mode: WriteMode;
  songBefore?: TrackSummary;
  songAfter?: TrackSummary;
  /** ms until it was ready to air (script + first clip) */
  tookMs: number;
  /** ms spent writing the script */
  writeMs?: number;
  /** why the scripted fallback or this device's voice stood in (the AI or voice server was out of reach) */
  standIn?: string;
  /** who stood in: the scripted fallback (brain failed), the device voice, or both */
  standInFor?: { brain?: boolean; voice?: boolean };
  /** the brain's error code (chatgpt_limit ...) */
  standInCode?: string;
}

export interface PrepareInput {
  station: Station;
  kind: BreakKind;
  callIn?: string;
  songBefore?: Track | TrackSummary;
  songAfter?: Track | TrackSummary;
  upcoming?: Track[];
  signal?: AbortSignal;
  /** a song request (call-in or AI app) already queued next, or not found */
  request?: SongRequest;
  /** a Notion ask (call-in or AI app) already sent: the break confirms it */
  notion?: NotionWrite;
  /** a break on air right now and not in the log yet (talk over the intro): counts as the latest break */
  onAir?: Break;
  /** when the break should be on air (ms epoch, the song's end): the brain and voices get budgets that fit */
  deadline?: number;
  /** progress for the UI */
  onStage?: (stage: 'context' | 'writing' | 'voicing') => void;
}

export async function loadLineup(station: Station): Promise<Host[]> {
  const hosts = await Promise.all(station.hostIds.slice(0, 4).map((id) => getHost(id)));
  return hosts.filter((h): h is Host => Boolean(h));
}

export async function loadBrains(hosts: Host[]): Promise<Map<string, Brain>> {
  const map = new Map<string, Brain>();
  for (const h of hosts) {
    const id = realBrainId(h.brainId);
    if (id && !map.has(id)) map.set(id, await resolveBrain(id));
  }
  return map;
}

const warmed = new Set<string>();

/**
 * Wakes the station's local models when it goes on air (a cold Ollama/LM Studio load can take 40 s, longer than a
 * short song): one tiny request each, once per session. Cloud brains are never called for this (they cost money
 * and have no cold start worth paying for).
 */
export async function warmUpBrains(station: Station): Promise<void> {
  const brains = await loadBrains(await loadLineup(station)).catch(() => new Map<string, Brain>());
  for (const brain of brains.values()) {
    if (warmed.has(brain.id) || isFallback(brain) || brain.kind !== 'openai' || brain.transport === 'server' || !isLocal(brain)) continue;
    warmed.add(brain.id);
    void generate(brain, { system: 'Answer with one word.', messages: [{ role: 'user', content: 'Ready?' }], maxTokens: 2 }, { timeoutMs: 90_000 }).catch(() => {
      warmed.delete(brain.id);
    });
  }
}

/** voice requests in flight per break (Host-Caster's included voices allow 4 per listener) */
const VOICE_PARALLEL = 4;
const BRAIN_TIMEOUT_MS = 45_000;
const VOICE_TIMEOUT_MS = 40_000;
/** the shortest budgets a deadline can squeeze the brain and a voice line to */
const BRAIN_MIN_MS = 12_000;
const VOICE_MIN_MS = 10_000;

/** Starts fn over items with at most `limit` in flight, in order; returns one promise per item right away. */
function startLimited<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R>[] {
  let free = limit;
  const waiting: (() => void)[] = [];
  const slot = () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };
  return items.map((item, i) => slot().then(() => fn(item, i).finally(release)));
}

/** Time left before `deadline`, kept between `min` and `max`. */
const budget = (deadline: number | undefined, reserve: number, min: number, max: number) =>
  deadline ? Math.max(min, Math.min(max, deadline - Date.now() - reserve)) : max;

/** This device's voice for a host (the stand-in when a voice server fails or is too slow). */
export function deviceStandIn(host: Host): Host {
  return { ...host, voice: { ...host.voice, voiceProviderId: DEVICE_VOICE_ID, voiceId: '' } };
}

export async function prepareBreak(input: PrepareInput): Promise<PreparedBreak> {
  const t0 = Date.now();
  const { station, signal } = input;
  const hosts = await loadLineup(station);
  if (!hosts.length) throw new Error('This station has no hosts');
  const brains = await loadBrains(hosts);

  input.onStage?.('context');
  const packet = await buildContext(station, { songBefore: summarize(input.songBefore), songAfter: summarize(input.songAfter), upcomingSongs: input.upcoming });
  if (input.onAir && !packet.recentBreaks.some((b) => b.id === input.onAir!.id)) packet.recentBreaks = [input.onAir, ...packet.recentBreaks];
  const plan = planBreak(station, packet, packet.recentBreaks, { kind: input.kind, callIn: input.callIn, hostCount: hosts.length, request: input.request, notion: input.notion });

  input.onStage?.('writing');
  // Offline (airplane mode, the computer with the model is off): the scripted fallback and this device's voice stand
  // in, so the hosts still talk. Only a cancel ends the break.
  let standIn: string | undefined;
  let standInCode: string | undefined;
  const standInFor: { brain?: boolean; voice?: boolean } = {};
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let written: WrittenBreak;
  const tw = Date.now();
  try {
    // leave the voices ~15 s of the time before the song ends
    written = await writeBreak({ station, hosts, brains, plan, packet, signal, timeoutMs: budget(input.deadline, 15_000, BRAIN_MIN_MS, BRAIN_TIMEOUT_MS) });
  } catch (err) {
    if (signal?.aborted || writeMode(hosts, brains) === 'builtin') throw err;
    standIn = why(err);
    standInFor.brain = true;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') standInCode = code;
    written = { mode: 'builtin', lines: writeBuiltinBreak(station, hosts, plan, packet) };
  }
  if (signal?.aborted) throw new Error('Break cancelled');

  const writeMs = Date.now() - tw;
  input.onStage?.('voicing');
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const b: PreparedBreak = {
    station,
    hosts,
    plan,
    packet,
    lines: written.lines,
    clips: [],
    mode: written.mode,
    songBefore: packet.songBefore,
    songAfter: packet.songAfter,
    tookMs: 0,
    writeMs,
    ...(standIn ? { standIn, standInFor, ...(standInCode ? { standInCode } : {}) } : {}),
  };
  const voiceBudget = budget(input.deadline, 0, VOICE_MIN_MS, VOICE_TIMEOUT_MS);
  // every clip settles: a voice that fails (or is aborted) gives this device's voice for that line
  const clips = startLimited(written.lines, VOICE_PARALLEL, async (line) => {
    const host = byId.get(line.hostId) ?? hosts[0]!;
    try {
      return await speak(host, line.text, { signal, timeoutMs: voiceBudget });
    } catch (err) {
      if (signal?.aborted || host.voice.voiceProviderId === DEVICE_VOICE_ID) return speak(deviceStandIn(host), line.text);
      b.standIn ??= why(err);
      b.standInFor = { ...b.standInFor, voice: true };
      // the voice's error code (included_budget_reached ...) when the brain had none
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') b.standInCode ??= code;
      return speak(deviceStandIn(host), line.text);
    }
  });
  b.clips = clips;
  if (clips.length) b.clips[0] = await clips[0]!;
  if (signal?.aborted) throw new Error('Break cancelled');
  b.tookMs = Date.now() - t0;
  return b;
}
