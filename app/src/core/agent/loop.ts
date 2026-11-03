// The hosts' agent loop: the brain looks things up with tools until it knows enough, then answers. Native tool
// calls where the brain takes them; otherwise (a model or server that refuses tools, or one that answers them badly)
// a JSON way of asking: {"tool": .., "args": ..} for a lookup, {"done": ..} for the answer. Which way works is
// remembered per brain (kv). Hard caps: steps and lookups per task, a deadline per task.
import { generate } from '../ai/generate';
import { isLocal } from '../ai/openai';
import { extractJson } from '../ai/json';
import { kvGet, kvSet } from '../db';
import type { AgentMessage, Brain, ToolCall, ToolSpec } from '../types';
import { modelStep, TooManyToolsError, ToolsUnsupportedError } from './step';
import { runTool, TOOL_SPECS, type ToolContext, type ToolName } from './tools';

export type ToolMode = 'native' | 'json';

const modeKey = (brain: Brain) => `agent:mode:${brain.id}:${brain.model ?? ''}`;

export async function toolMode(brain: Brain): Promise<ToolMode> {
  const row = await kvGet<{ mode: ToolMode; at: number }>(modeKey(brain));
  // re-check a JSON verdict after 14 days (servers and models gain tool support)
  if (row?.value?.mode === 'json' && Date.now() - row.value.at < 14 * 86_400_000) return 'json';
  return 'native';
}

export async function rememberMode(brain: Brain, mode: ToolMode): Promise<void> {
  await kvSet(modeKey(brain), { mode, at: Date.now() });
}

/** Where a tool call runs: the model step, whether a tool result was already in the context, and a way to load tools. */
export interface StepInfo {
  step: number;
  seenResults: boolean;
  /** deferred tools to send with the next model steps (find_tools) */
  load(names: string[]): void;
}

/** A tool the loop can run directly (the hosts' tool kit, core/agent/kit): its spec and its run. */
export interface KitTool {
  spec: ToolSpec;
  /** only on the turn's first model step, before any tool result is in the context (approvals) */
  firstStepOnly?: boolean;
  /** its schema is not sent until find_tools loads it (or the model calls it by name from the directory) */
  deferred?: boolean;
  /** find_tools: not counted against the turn's tools, and its answer is the app's own list (not a tool result) */
  discovery?: boolean;
  run(args: Record<string, unknown>, at: StepInfo): Promise<{ ok: boolean; content: string; what: string }>;
}

export interface AgentTask {
  brain: Brain;
  /** who the model is and what it is for */
  system: string;
  /** the question or the item to research, with what is already known */
  user: string;
  tools: ToolName[];
  /** the tool kit for this turn: when set, these are the tools (instead of `tools`) */
  kit?: KitTool[];
  ctx: ToolContext;
  /** model turns, the last one answers without tools */
  maxSteps: number;
  /** lookups in this task */
  maxCalls: number;
  /** epoch ms: past it, the task answers with what it has (or gives up) */
  deadline: number;
  signal?: AbortSignal;
  maxTokens?: number;
  /** what "done" should be: a JSON object (dossiers) or plain text (answers) */
  answer: 'json' | 'text';
  /** a lookup started (the radio can say "one sec, pulling that up") */
  onLookup?: (name: string, args: Record<string, unknown>) => void;
  /** a model step's own time cap before it is asked once more (default STEP_MS) */
  stepMs?: number;
  /**
   * after a step's tools ran (their names, the model's words with them, whether each worked): true ends the task
   * with no more model steps (code or the model already has the words)
   */
  stopAfter?: (names: string[], said: string, oks: boolean[]) => boolean;
}

export interface AgentCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  what: string;
  /** what came back (capped): links in an answer must come from here or from the task */
  content: string;
}

export interface AgentResult {
  /** the final answer (JSON text when answer = 'json') */
  text: string;
  /** parsed when answer = 'json' */
  json?: unknown;
  calls: AgentCall[];
  steps: number;
  mode: ToolMode;
  ms: number;
}

export class AgentTimeout extends Error {
  override name = 'AgentTimeout';
}

const left = (task: AgentTask) => task.deadline - Date.now();

/** A model step that takes longer than this has hung upstream (a normal one is 1-6 s): it is asked once more. */
export const STEP_MS = 9000;

/**
 * One model call with its own time cap, so one request that hangs at the provider does not eat the whole turn: past
 * STEP_MS it is asked once more with the time left. A model on this computer or the local network is never cut short
 * (a cold load takes its time).
 */
async function capped<T>(task: AgentTask, call: (opts: { signal?: AbortSignal; timeoutMs: number }) => Promise<T>): Promise<T> {
  const all = Math.max(2000, left(task) - 500);
  const cap = task.stepMs ?? STEP_MS;
  if (isLocal(task.brain) || all <= cap + 3000) return call({ signal: task.signal, timeoutMs: all });
  const ctl = new AbortController();
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    ctl.abort();
  }, cap);
  const stop = () => ctl.abort();
  task.signal?.addEventListener('abort', stop);
  try {
    return await call({ signal: ctl.signal, timeoutMs: cap + 1000 });
  } catch (err) {
    if (!hung || task.signal?.aborted || left(task) < 3000) throw err;
    return call({ signal: task.signal, timeoutMs: Math.max(2000, left(task) - 500) });
  } finally {
    clearTimeout(timer);
    task.signal?.removeEventListener('abort', stop);
  }
}

/** The JSON way of asking: the tool list and the two reply shapes, appended to the system prompt. */
export function jsonProtocol(tools: (ToolName | ToolSpec)[], answer: 'json' | 'text'): string {
  const specs = tools.map((t) => (typeof t === 'string' ? TOOL_SPECS[t] : t));
  const writes = specs.some((sp) => !(sp.name in TOOL_SPECS));
  const list = specs.map((spec) => {
    const props = Object.keys((spec.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    return `- ${spec.name} {${props.map((p) => `"${p}": ...`).join(', ')}}: ${spec.description}`;
  });
  return [
    writes ? 'You can use tools before you answer (look things up, or do what the listener asks). TOOLS:' : 'You can look things up before you answer. LOOKUPS:',
    ...list,
    'Reply with ONE JSON object and nothing else, either',
    `{"tool": "<${writes ? 'tool' : 'lookup'} name>", "args": {...}} to use one (you will get the result), or`,
    answer === 'json' ? '{"done": {...your answer object...}} when you know enough.' : '{"done": "your answer"} when you know enough.',
    writes ? 'Use only what you need, one tool at a time.' : 'Look up only what you need; at most a few lookups.',
  ].join('\n');
}

/** A JSON-way reply: a lookup or the answer. Plain text counts as the answer. */
export function readAction(text: string): { tool?: string; args?: Record<string, unknown>; done?: unknown } {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (typeof j.tool === 'string') return { tool: j.tool, args: (j.args && typeof j.args === 'object' ? j.args : {}) as Record<string, unknown> };
    if ('done' in j) return { done: j.done };
    if ('answer' in j) return { done: j.answer };
    return { done: j };
  }
  return { done: text.trim() };
}

function finish(task: AgentTask, raw: unknown, calls: AgentCall[], steps: number, mode: ToolMode, t0: number): AgentResult {
  let text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  let json: unknown;
  if (task.answer === 'json') {
    json = typeof raw === 'string' ? extractJson(raw) : raw;
    if (json && typeof json === 'object' && 'done' in (json as Record<string, unknown>)) json = (json as Record<string, unknown>).done;
    text = JSON.stringify(json ?? {});
  } else {
    // a model that wrapped its answer anyway
    const a = typeof raw === 'string' ? readAction(raw) : { done: raw };
    if (a.done !== undefined && !a.tool) text = typeof a.done === 'string' ? a.done : JSON.stringify(a.done);
  }
  return { text, json, calls, steps, mode, ms: Date.now() - t0 };
}

/**
 * open_link only opens an address that appears word for word in the task or in an earlier lookup's result. An email
 * or page the hosts read could otherwise get the model to build an address that carries private details elsewhere.
 */
export function linkKnown(url: string, task: Pick<AgentTask, 'system' | 'user'>, calls: Pick<AgentCall, 'content'>[]): boolean {
  const u = url.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return false;
  const seen = (s: string) => calls.some((c) => c.content.includes(s)) || task.user.includes(s) || task.system.includes(s);
  return seen(u) || (u.endsWith('/') && seen(u.slice(0, -1)));
}

const toolNames = (task: AgentTask) => (task.kit ? task.kit.map((k) => k.spec.name) : task.tools);
const isDiscovery = (task: AgentTask, name: string) => Boolean(task.kit?.find((k) => k.spec.name === name)?.discovery);
/** tool calls that count against the turn's cap (finding tools does not) */
const counted = (task: AgentTask, calls: AgentCall[]) => calls.filter((c) => !isDiscovery(task, c.name)).length;

/** The schemas sent with a model step: every tool, less the deferred ones not loaded yet. */
function activeSpecs(task: AgentTask, loaded: Set<string>): ToolSpec[] {
  if (!task.kit) return task.tools.map((n) => TOOL_SPECS[n]);
  return task.kit.filter((k) => !k.deferred || loaded.has(k.spec.name)).map((k) => k.spec);
}

/** Runs one tool call. `at`: this model step, and whether a tool result was already in the context when it began. */
async function lookup(task: AgentTask, call: { name: string; args: Record<string, unknown> }, calls: AgentCall[], at: StepInfo): Promise<string> {
  if (!isDiscovery(task, call.name) && counted(task, calls) >= task.maxCalls) return JSON.stringify({ error: 'No more tools for this turn: answer with what you have.' });
  const names = toolNames(task);
  if (!names.includes(call.name)) {
    const hint = task.kit?.some((k) => k.discovery) ? ' Load your other tools with find_tools.' : '';
    return JSON.stringify({ error: `${call.name} is not one of your tools.${hint}` });
  }
  if (call.name === 'open_link' && !linkKnown(String(call.args.url ?? ''), task, calls)) {
    return JSON.stringify({ error: 'Only links that appear in the items or in what you looked up can be opened. Copy the link exactly.' });
  }
  const kit = task.kit?.find((k) => k.spec.name === call.name);
  // an approval is taken only before anything the tools read (an email, a page) is in the context
  if (kit?.firstStepOnly && (at.step > 1 || at.seenResults)) {
    return JSON.stringify({ error: `${call.name} only works as the very first thing in a turn, right after the listener spoke. Nothing was done.` });
  }
  if (!kit?.discovery) task.onLookup?.(call.name, call.args);
  // a deferred tool called by its name from the directory runs (its own code checks the arguments) and stays loaded
  if (kit?.deferred) at.load([call.name]);
  const out = kit ? await kit.run(call.args, at) : await runTool(call.name, call.args, task.ctx, task.signal);
  calls.push({ name: call.name, args: call.args, ok: out.ok, what: out.what, content: out.content });
  return out.content;
}

/** The conversation so far as one plain question: the task and what each lookup found. */
export function flatten(user: string, messages: AgentMessage[]): AgentMessage[] {
  const found = messages
    .filter((m): m is Extract<AgentMessage, { role: 'tool' }> => m.role === 'tool')
    .map((m) => `- ${m.name}: ${m.content}`);
  const content = found.length ? `${user}\n\nWHAT YOUR LOOKUPS FOUND:\n${found.join('\n')}\n\nAnswer now with what you found (no more lookups).` : `${user}\n\nAnswer now.`;
  return [{ role: 'user', content }];
}

async function runNative(task: AgentTask, t0: number): Promise<AgentResult> {
  const messages: AgentMessage[] = [{ role: 'user', content: task.user }];
  const calls: AgentCall[] = [];
  const loaded = new Set<string>();
  // a tool result (an email, a page) is in the context: what find_tools lists is the app's own, not one
  let seen = false;
  for (let step = 1; step <= task.maxSteps; step++) {
    const last = step === task.maxSteps || counted(task, calls) >= task.maxCalls || left(task) < 6000;
    if (left(task) < 2500) throw new AgentTimeout('Out of time');
    const r = await capped(task, (fo) =>
      modelStep(
        task.brain,
        {
          system: task.system,
          // the last turn has no tools: the lookups so far go in as plain text (every provider takes that)
          messages: last ? flatten(task.user, messages) : messages,
          tools: last ? undefined : activeSpecs(task, loaded),
          maxTokens: task.maxTokens ?? 700,
        },
        fo,
      ),
    );
    // a model that writes the JSON way while it has tools ("answers badly"): treat it as asked
    if (!r.toolCalls.length && !last) {
      const a = r.text ? readAction(r.text) : undefined;
      if (a?.tool) r.toolCalls = [{ id: `json_${step}`, name: a.tool, args: a.args ?? {} }];
    }
    if (!r.toolCalls.length) {
      if (!r.text.trim()) throw new Error('The brain gave an empty answer');
      return finish(task, r.text, calls, step, 'native', t0);
    }
    const toolCalls: ToolCall[] = r.toolCalls.slice(0, 3);
    messages.push({ role: 'assistant', content: r.text, toolCalls });
    const at: StepInfo = { step, seenResults: seen, load: (names) => names.forEach((n) => loaded.add(n)) };
    const results = await Promise.all(toolCalls.map((c) => lookup(task, c, calls, at)));
    toolCalls.forEach((c, i) => messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: results[i]! }));
    if (toolCalls.some((c) => !isDiscovery(task, c.name))) seen = true;
    const oks = toolCalls.map((c) => calls.find((x) => x.name === c.name && x.args === c.args)?.ok ?? false);
    if (task.stopAfter?.(toolCalls.map((c) => c.name), r.text, oks)) return finish(task, r.text, calls, step, 'native', t0);
  }
  throw new Error('No answer within the step limit');
}

async function runJson(task: AgentTask, t0: number): Promise<AgentResult> {
  // the deferred tools' schemas come back in find_tools' RESULT; the model may then use them the same way
  const system = `${task.system}\n\n${jsonProtocol(activeSpecs(task, new Set()), task.answer)}`;
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: task.user }];
  const calls: AgentCall[] = [];
  const load = () => undefined;
  for (let step = 1; step <= task.maxSteps; step++) {
    const last = step === task.maxSteps || counted(task, calls) >= task.maxCalls || left(task) < 6000;
    if (left(task) < 2500) throw new AgentTimeout('Out of time');
    const text = await capped(task, (fo) =>
      generate(
        task.brain,
        {
          system,
          messages: last ? [...messages, { role: 'user', content: 'No more lookups: reply now with {"done": ...}.' }] : messages,
          json: true,
          maxTokens: task.maxTokens ?? 700,
        },
        fo,
      ),
    );
    const a = readAction(text);
    if (a.tool && !last) {
      const result = await lookup(task, { name: a.tool, args: a.args ?? {} }, calls, { step, seenResults: counted(task, calls) > 0, load });
      if (task.stopAfter?.([a.tool], '', [calls.at(-1)?.name === a.tool && calls.at(-1)!.ok])) return finish(task, '', calls, step, 'json', t0);
      messages.push({ role: 'assistant', content: JSON.stringify({ tool: a.tool, args: a.args ?? {} }) });
      messages.push({ role: 'user', content: `RESULT of ${a.tool}: ${result}\n\nNext: another lookup, or {"done": ...}.` });
      continue;
    }
    return finish(task, a.done ?? text, calls, step, 'json', t0);
  }
  throw new Error('No answer within the step limit');
}

/** Runs a task to its answer, within its caps. */
export async function runAgent(task: AgentTask): Promise<AgentResult> {
  const t0 = Date.now();
  const mode = task.tools.length || task.kit?.length ? await toolMode(task.brain) : 'native';
  if (mode === 'json') return runJson(task, t0);
  try {
    return await runNative(task, t0);
  } catch (err) {
    if (err instanceof TooManyToolsError) return runJson(task, t0);
    if (!(err instanceof ToolsUnsupportedError)) throw err;
    await rememberMode(task.brain, 'json');
    return runJson(task, t0);
  }
}
