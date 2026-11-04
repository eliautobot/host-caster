// One agent turn for every door (docs/AGENT.md, section 5): the live call, the chat, an on-air call-in and a note
// from the listener's AI app. The toolbox is rebuilt from what is connected and allowed, the system prompt gets the
// self-knowledge, the model decides from the whole conversation and may chain tools; the effects (proposals,
// approvals, app changes) come back so the reply can end with code's exact lines.
import { actionHistory, waitingActions } from '../../actions/engine';
import type { ActionRecord } from '../../actions/types';
import { recentChanges } from './changes';
import { latestAsked, rememberAsked } from './approval';
import type { Brain } from '../../types';
import { speakable } from '../../tracker/safety';
import { runAgent, type AgentCall, type KitTool } from '../loop';
import type { ToolContext } from '../tools';
import { findTools, FIND_TOOLS, planTools, type ToolPlan } from './discover';
import { loadEnv } from './env';
import { buildToolbox } from './registry';
import { selfKnowledge } from './selfknow';
import './sources';
import type { Effect, MusicHooks, RunInfo, Toolbox, TurnKind } from './types';

export interface TurnInput {
  turn: Exclude<TurnKind, 'background'>;
  brain: Brain;
  /** who the host is and how to talk (the self-knowledge is added to it) */
  system: string;
  /** the facts and the conversation, ending with what the listener just said */
  user: string;
  /** the listener's words in this turn */
  said: string;
  /** the listener's own words in this conversation (writes must be made of these) */
  heard: string;
  ctx: ToolContext;
  music?: MusicHooks;
  maxSteps: number;
  maxCalls: number;
  deadline: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onLookup?: (name: string) => void;
  /**
   * the conversation's tools (a call or a chat keeps one set across its turns): what it used or loaded stays loaded,
   * and this turn's are added
   */
  keep?: string[];
  /** the conversation's memory of what its last turn could do (filled in here): a change since then is told */
  last?: { offered?: string[] };
}

export interface TurnResult {
  text: string;
  effects: Effect[];
  calls: AgentCall[];
  box: Toolbox;
  plan: ToolPlan;
}

/** The latest turns, newest last (how many model steps, which tools, how long): for checks and the debug build. */
export interface TurnTrace {
  turn: TurnKind;
  ms: number;
  steps: number;
  mode: string;
  /** tool schemas sent with the first step */
  sent: number;
  calls: string[];
  /** a short fingerprint of the system text and the tools sent: the same one turn after turn = a cacheable prompt */
  prompt: string;
}
export const turnTrace: TurnTrace[] = [];

/**
 * What changed in the hosts' tools since the conversation's last turn (a switch, a policy, a service connected), in
 * the turn's own message: the system text stays the same for the provider's cache, and the model does not lean on
 * what it said a minute ago ("yes, I can add tasks") when that is no longer true.
 */
export function changesSince(box: Toolbox, last: { offered?: string[] }): string {
  const now = box.offered.map((o) => o.tool.name);
  const before = last.offered;
  last.offered = now;
  if (!before) return '';
  const gone = box.off.filter((o) => before.includes(o.tool.name));
  const back = box.offered.filter((o) => !before.includes(o.tool.name) && o.tool.group !== 'Approvals');
  const lines = [
    ...gone.map((o) => `- now OFF: ${o.tool.title} (${o.fix})`),
    ...back.map((o) => `- now ON: ${o.tool.title}`),
  ];
  return lines.length ? `CHANGED SINCE YOUR LAST ANSWER (Settings changed during this conversation; this is what is true now):\n${lines.join('\n')}` : '';
}

/** A short, stable fingerprint of a text (FNV-1a). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** a second request joined to the first in the listener's own words */
const SEVERAL = /\b(?:and|then|also|plus)\s+(?:also\s+|then\s+|please\s+)?(?:remind|add|put|move|delete|remove|cancel|remember|mark|tick|book|schedule|play|change|accept|decline|tell|set)\b/i;

/** effects code speaks word for word */
const EXACT = new Set<Effect['kind']>(['asked', 'ran', 'cancelled', 'said']);

const MAX_RESULT = 3500;
const asText = (v: string | Record<string, unknown>) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}...(cut)` : t;
};

/** How one tool run ended: whether it worked and whether it finished the job in code's own words. */
export interface RunEnd {
  name: string;
  ok: boolean;
  /** code's words for a finished app change (ToolRun.said) */
  said?: string;
  /** it left only code's exact lines (a read-back, a done line) */
  exact: boolean;
  /** the model said it will do more in this turn (the `also` argument) */
  more?: boolean;
}

/** Every change tool takes `also`: the model says it has more to do this turn, so the turn does not end on this step. */
const ALSO = { type: 'string', description: 'only when the listener asked for more in this turn: the next thing you will do ("remind them the day before"); leave it out otherwise' };
const withAlso = (p: Record<string, unknown>) => ({ ...p, properties: { ...((p.properties as Record<string, unknown>) ?? {}), also: ALSO } });

/** The kit tools for the loop: each run gets the turn's facts and adds its effects. Deferred ones wait for find_tools. */
export function kitTools(box: Toolbox, base: Omit<RunInfo, 'step' | 'seenResults' | 'policy'>, plan?: ToolPlan, ends: RunEnd[] = []): KitTool[] {
  return box.offered.map(({ tool, policy }) => ({
    // approvals take `also` too: "no, just mark it done instead" drops the waiting change and goes on to the new one
    spec: { name: tool.name, description: tool.description, parameters: tool.kind === 'read' ? tool.parameters : withAlso(tool.parameters) },
    firstStepOnly: tool.firstStepOnly,
    ...(plan && !plan.sent.has(tool.name) ? { deferred: true } : {}),
    async run(args, at) {
      try {
        const out = await tool.run(args, { ...base, ...at, policy });
        const made = out.effect ? (Array.isArray(out.effect) ? out.effect : [out.effect]) : [];
        base.effects.push(...made);
        const more = typeof args.also === 'string' && args.also.trim().length > 0;
        ends.push({ name: tool.name, ok: out.ok, ...(out.said ? { said: out.said } : {}), exact: made.length > 0 && made.every((e) => EXACT.has(e.kind)), ...(more ? { more } : {}) });
        return { ok: out.ok, content: asText(out.content), what: out.what };
      } catch (err) {
        ends.push({ name: tool.name, ok: false, exact: false });
        return { ok: false, content: asText({ error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }), what: `${tool.name} (did not work)` };
      }
    },
  }));
}

/** WAITING FOR A YES: what the listener already heard read back (the model calls approve_action on a yes). */
export async function waitingSheet(before: number): Promise<string> {
  const waiting = await waitingActions(before).catch(() => []);
  if (!waiting.length) return '';
  const asked = new Set(await latestAsked());
  return `WAITING FOR THE LISTENER'S YES (already read back to them; a plain yes or no answers the question just read back, all of it: call approve_action or cancel_action first, without an action_id):\n${waiting
    .slice(0, 3)
    .map((a) => `- action_id ${a.id}: ${speakable(a.summary, 200)}${asked.has(a.id) ? ' (in the question just read back)' : ' (older, still on its card)'}`)
    .join('\n')}`;
}

/** How far back LATELY looks: what the hosts did for the listener in this sitting. */
const LATELY_MS = 30 * 60_000;
const DID: Partial<Record<ActionRecord['status'], string>> = { done: 'done', cancelled: 'they said no', failed: 'did not work', undone: 'undone', expired: 'nobody said yes' };
const ago = (ms: number) => (ms < 90_000 ? 'just now' : `${Math.round(ms / 60_000)} min ago`);

/**
 * LATELY: what the hosts did for the listener in the last half hour, wherever it happened (a call, the chat, an on-air
 * call-in), newest first, so "forget that", "undo that" or "move it" find what the listener means. Waiting proposals are
 * in WAITING FOR A YES instead. Data for the model, never instructions.
 */
export async function latelySheet(now: number): Promise<string> {
  const since = now - LATELY_MS;
  const [changes, actions] = await Promise.all([recentChanges(since).catch(() => []), actionHistory(10).catch(() => [] as ActionRecord[])]);
  const rows = [
    ...changes.map((c) => ({ at: c.at, line: c.what })),
    ...actions
      .filter((a) => a.createdAt >= since && DID[a.status])
      .map((a) => ({ at: a.executedAt ?? a.confirmedAt ?? a.createdAt, line: `${speakable(a.summary, 160)} (${DID[a.status]})` })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
  if (!rows.length) return '';
  return `LATELY FOR THE LISTENER (newest first; only to understand "that", "it", "again" or "undo". A request that names something is a new request: do it, even when it sounds like one of these):\n${rows.map((r) => `- ${ago(now - r.at)}: ${r.line}`).join('\n')}`;
}

/** words that put off a change in another account to a confirmation the model itself never asked for with a tool */
const PUT_OFF = /\b(?:needs?|requires?) (?:your |a )?(?:confirmation|approval|ok(?:ay)?|go-ahead|yes)\b|\bthe app (?:will|'ll|’ll) ask\b|\b(?:I'll|I’ll|I will) (?:need to )?(?:ask|check with) you (?:first|before)\b|\bbefore (?:it'?s|it’s|it is) (?:removed|deleted|added|moved|changed|cancell?ed)\b/i;

/** The model's answer put off a change in another account, no proposal was made, and such a change could be made. */
export function talkedNotProposed(text: string, effects: Effect[], box: Pick<Toolbox, 'offered'>, input: Pick<TurnInput, 'said'>): boolean {
  if (!PUT_OFF.test(text) || effects.some((e) => e.kind === 'asked')) return false;
  // a question from the listener ("can you delete tasks?") is answered, never acted on
  if (/\?\s*$/.test(input.said.trim())) return false;
  return box.offered.some((o) => o.tool.kind === 'outside-write');
}

const NOT_PROPOSED_NOTE = (said: string) =>
  `[NOTE FROM THE APP: your answer was "${said.slice(0, 200)}" but you did not call the tool, so no question was read back and nothing can happen. Call the tool for that change NOW: it only prepares the question, the app reads it back and waits for the listener's yes. Do not ask for confirmation in your own words.]`;

export async function agentTurn(input: TurnInput): Promise<TurnResult> {
  const startedAt = Date.now();
  const env = await loadEnv({ turn: input.turn, ctx: input.ctx, hasBrain: true, music: input.music });
  const box = await buildToolbox(env);
  const effects: Effect[] = [];
  const waiting = box.get('approve_action') ? await waitingSheet(startedAt) : '';
  const lately = await latelySheet(startedAt);
  const keep = input.keep ?? [];
  const plan = planTools(box, { keep });
  const ends: RunEnd[] = [];
  const kit = kitTools(box, { env, said: input.said, heard: input.heard, startedAt, effects, signal: input.signal }, plan, ends);
  // loaded once, kept for the conversation (append only: the same tools in the same order turn after turn)
  const remember = (names: string[]) => {
    for (const n of names) if (plan.later.has(n) && !keep.includes(n)) keep.push(n);
  };
  // what find_tools loads is kept only once it is used: the conversation's tools grow by what it really needs
  if (plan.deferred.length) kit.push(findTools(plan, box.off, () => undefined));
  // a step whose every tool finished the job in code's words (a read-back, a done line, "Got it, I'll remember
  // that ...") ends the turn: no model step is needed to say them, and the listener hears them sooner. A look-up never
  // ends a turn (the answer comes from its result), nor does a change that did not work (the model explains).
  // the listener asked for more than one thing ("move it and remind me the day before"): the first step does not end
  // the turn even when its tools finished, so the model can do the rest (one more step, only then)
  const several = SEVERAL.test(input.said);
  let seen = 0;
  let changeSteps = 0;
  let last: RunEnd[] = [];
  const stopAfter = (names: string[]) => {
    last = ends.slice(seen);
    seen = ends.length;
    const finished = names.length > 0 && last.length === names.length && last.every((e) => (e.exact || (e.ok && e.said)) && !e.more);
    if (!finished) return false;
    // the first step that CHANGED something (a look-up before it does not count) leaves room for the rest of "... and ..."
    changeSteps++;
    return !(several && changeSteps === 1);
  };
  const system = `${input.system}\n\n${selfKnowledge(box, plan)}`;
  const changed = input.last ? changesSince(box, input.last) : '';
  const user = [changed, lately, waiting, input.user].filter(Boolean).join('\n\n');
  const run = (u: string) =>
    runAgent({
      brain: input.brain,
      system,
      user: u,
      tools: [],
      kit,
      ctx: input.ctx,
      maxSteps: input.maxSteps,
      maxCalls: input.maxCalls,
      deadline: input.deadline,
      signal: input.signal,
      answer: 'text',
      maxTokens: input.maxTokens,
      onLookup: (name) => input.onLookup?.(name),
      stopAfter,
    });
  let res = await run(user);
  // a change in another account talked about but never proposed ("deleting it needs your confirmation, the app will
  // ask") leaves no Yes/No card, so the listener's yes does nothing: the model gets one more step to call the tool
  if (talkedNotProposed(res.text, effects, box, input) && !input.signal?.aborted && (!input.deadline || input.deadline - Date.now() > 4000)) {
    const again = await run(`${user}\n\n${NOT_PROPOSED_NOTE(res.text)}`);
    res = { ...again, calls: [...res.calls, ...again.calls], steps: res.steps + again.steps, ms: res.ms + again.ms };
  }
  // what the conversation used stays loaded for its next turns
  remember(res.calls.filter((c) => c.name !== FIND_TOOLS && box.get(c.name)).map((c) => c.name));
  // the question read back now is what the listener's next yes or no answers (all of it, nothing older)
  await rememberAsked(effects.flatMap((e) => (e.kind === 'asked' ? [e.action.id] : [])), startedAt).catch(() => undefined);
  turnTrace.push({
    turn: input.turn,
    ms: res.ms,
    steps: res.steps,
    mode: res.mode,
    sent: plan.sent.size + (plan.deferred.length ? 1 : 0),
    calls: res.calls.map((c) => `${c.name}${c.name === FIND_TOOLS ? JSON.stringify(c.args).slice(0, 80) : ''}`),
    prompt: fingerprint(`${system}\n${kit.filter((k) => !k.deferred).map((k) => k.spec.name).join(',')}`),
  });
  if (turnTrace.length > 50) turnTrace.shift();
  // ended on code's words with nothing from the model: the finished changes speak for themselves
  const text = res.text.trim() ? res.text : last.map((e) => e.said ?? '').filter(Boolean).join(' ');
  return { text, effects, calls: res.calls, box, plan };
}

if (typeof window !== 'undefined' && import.meta.env.VITE_HOSTCASTER_DEBUG === '1') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  const g = (w.__hostcaster ??= {});
  g.agent = { ...((g.agent as object) ?? {}), turns: turnTrace };
}
