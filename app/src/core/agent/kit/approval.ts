// The listener's spoken or typed yes (docs/AGENT.md, section 4). approve_action runs a waiting proposal only when ALL
// hold, checked by code here (the loop checks 2 as well):
//   1. a listener turn (call, chat, on-air call-in): never an AI app, never a break;
//   2. the turn's FIRST model step, before any tool result (an email, a page, a note) is in the context;
//   3. the listener's own words in this turn carry a yes and are not a no or a change (saysYes);
//   4. the proposal was made before this turn (they heard its read-back) and is still waiting.
// So text inside an email or a web page can never approve anything: by the time the model has read it, approving
// is no longer possible, and the words that approve must be the listener's.
import { confirmBy } from '../../actions/callin';
import { isQuestionNotOrder } from '../question';
import { cancelAction, classifyAnswer, waitingActions } from '../../actions/engine';
import type { ActionRecord, ConfirmVia } from '../../actions/types';
import { ranRun } from './sources/outside';
import { str } from './sources/needs';
import { kvGet, kvSet } from '../../db/kv';
import { isListenerTurn, OK, type AgentTool, type Effect, type RunInfo, type ToolRun } from './types';

const YES_WORD = /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|alright|all right|go ahead|do it|please do|confirm(?:ed)?|sounds good|absolutely|definitely|of course|correct|that'?s right|perfect|go for it)\b/;
const NOT_YES = /\b(?:no|nope|nah|not|don'?t|do not|never|cancel|stop|wait|hold on|hang on|instead|but|change|actually|rather|later|undo)\b/;

/** The listener's words carry a plain yes (code, never a model): "yes", "yeah do it", "sure, and remind me ...". */
export function saysYes(said: string): boolean {
  const s = said
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return false;
  const c = classifyAnswer(s);
  if (c !== 'other') return c === 'yes';
  // "can you approve things?", "is it done?": a question is never a yes
  if (/\?\s*$/.test(said.trim()) || isQuestionNotOrder(s)) return false;
  // the first part of what they said is the answer: "yes, and add milk" is a yes; "yes but at 4" is a change
  const head = s.split(/[.!?;]|,? and (?:also |then )?/)[0] ?? s;
  return YES_WORD.test(head) && !NOT_YES.test(head) && head.split(' ').length <= 8;
}

const viaOf = (turn: RunInfo['env']['turn']): ConfirmVia => (turn === 'chat' ? 'chat' : turn === 'call' ? 'call' : 'call-in');

const fail = (message: string, what: string): ToolRun => ({ ok: false, content: { error: message }, what });

const LAST_ASKED = 'agent:lastAsked';

/** The proposals read back together in the latest question ("Should I go ahead with both?"), for the next yes or no. */
export async function rememberAsked(ids: string[], at = Date.now()): Promise<void> {
  if (ids.length) await kvSet(LAST_ASKED, { at, ids });
}

export async function latestAsked(): Promise<string[]> {
  return (await kvGet<{ at: number; ids: string[] }>(LAST_ASKED).catch(() => undefined))?.value?.ids ?? [];
}

/**
 * The proposals a spoken yes or no answers: the LATEST question read back, all of it ("both"), never an older one the
 * listener may have forgotten (those stay on their cards for a tap). A named action_id from that question means that
 * question; a named older one means only that one. Nothing recorded (another device): the newest one only.
 */
async function targets(args: Record<string, unknown>, run: RunInfo): Promise<ActionRecord[]> {
  const waiting = await waitingActions(run.startedAt);
  const asked = new Set(await latestAsked());
  const question = waiting.filter((a) => asked.has(a.id));
  const id = str(args.action_id, 60);
  if (id) {
    const named = waiting.filter((a) => a.id === id);
    return named.length && question.some((a) => a.id === id) ? question.slice(0, 3) : named;
  }
  return (question.length ? question : waiting.slice(0, 1)).slice(0, 3);
}

/** Why approve_action may not run now (undefined = it may). Exported for the tests and the loop. */
export function approvalProblem(run: Pick<RunInfo, 'env' | 'step' | 'seenResults' | 'said'>): string | undefined {
  if (!isListenerTurn(run.env.turn)) return 'Only the listener can say yes, in a call, the chat or a call-in. Nothing was approved.';
  if (run.step !== 1 || run.seenResults) return 'approve_action only works as the very first thing in a turn, right after the listener said yes. Nothing was approved.';
  if (!saysYes(run.said)) return 'The listener did not say yes in this turn, so nothing was approved. If what is waiting is what they mean, ask them for a yes; if they mean something else (another item, another time), call that change\'s tool with it.';
  return undefined;
}

export const approveTool: AgentTool = {
  name: 'approve_action',
  title: 'Do what I said yes to',
  group: 'Approvals',
  description:
    'The listener just said yes to what is WAITING FOR A YES: call this first, before anything else, and the app does it. Only when their words in this turn are a yes.',
  parameters: { type: 'object', properties: { action_id: { type: 'string', description: 'the action_id; optional (default: everything waiting)' } }, required: [] },
  kind: 'outside-write',
  policies: [],
  defaultPolicy: 'auto',
  firstStepOnly: true,
  available: () => OK,
  async run(args, run) {
    const problem = approvalProblem(run);
    if (problem) return fail(problem, 'Approval refused');
    const list = await targets(args, run);
    if (!list.length) return fail("Nothing is waiting for a yes, so nothing was done. If the listener asked for a change in this conversation, call that change's tool now: the app reads it back and asks them for the yes. Never ask for a yes in your own words.", 'Approval (nothing waiting)');
    const effects: Effect[] = [];
    const results: unknown[] = [];
    for (const a of list) {
      const r = ranRun(await confirmBy(a, viaOf(run.env.turn)).catch(() => undefined), a);
      results.push(r.content);
      if (r.effect) effects.push(...(Array.isArray(r.effect) ? r.effect : [r.effect]));
    }
    return { ok: effects.some((e) => e.kind === 'ran' && e.action.status === 'done'), content: { results }, what: `Approved ${list.length}`, effect: effects };
  },
};

export const cancelTool: AgentTool = {
  name: 'cancel_action',
  title: 'Drop what I said no to',
  group: 'Approvals',
  description: 'The listener said no (or changed their mind) about what is WAITING FOR A YES: drop it. Nothing happens.',
  parameters: { type: 'object', properties: { action_id: { type: 'string', description: 'the action_id; optional (default: everything waiting)' } }, required: [] },
  kind: 'outside-write',
  policies: [],
  defaultPolicy: 'auto',
  firstStepOnly: true,
  available: () => OK,
  async run(args, run) {
    if (!isListenerTurn(run.env.turn)) return fail('Only the listener can say no.', 'Cancel refused');
    const list = await targets(args, run);
    if (!list.length) return fail('Nothing is waiting.', 'Cancel (nothing waiting)');
    const effects: Effect[] = [];
    for (const a of list) effects.push({ kind: 'cancelled', action: await cancelAction(a) });
    return { ok: true, content: { status: 'dropped', what: list.map((a) => a.summary) }, what: `Dropped ${list.length}`, effect: effects };
  },
};
