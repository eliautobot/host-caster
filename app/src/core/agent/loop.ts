// The hosts' agent loop: the brain looks things up with tools until it knows enough, then answers. Native tool
// calls where the brain takes them; otherwise (a model or server that refuses tools, or one that answers them badly)
// a JSON way of asking: {"tool": .., "args": ..} for a lookup, {"done": ..} for the answer. Which way works is
// remembered per brain (kv). Hard caps: steps and lookups per task, a deadline per task.
import { generate } from '../ai/generate';
import { extractJson } from '../ai/json';
import { kvGet, kvSet } from '../db';
import type { AgentMessage, Brain, ToolCall } from '../types';
import { modelStep, ToolsUnsupportedError } from './step';
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

export interface AgentTask {
  brain: Brain;
  /** who the model is and what it is for */
  system: string;
  /** the question or the item to research, with what is already known */
  user: string;
  tools: ToolName[];
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

/** The JSON way of asking: the tool list and the two reply shapes, appended to the system prompt. */
export function jsonProtocol(tools: ToolName[], answer: 'json' | 'text'): string {
  const list = tools.map((n) => {
    const spec = TOOL_SPECS[n];
    const props = Object.keys((spec.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    return `- ${n} {${props.map((p) => `"${p}": ...`).join(', ')}}: ${spec.description}`;
  });
  return [
    'You can look things up before you answer. LOOKUPS:',
    ...list,
    'Reply with ONE JSON object and nothing else, either',
    '{"tool": "<lookup name>", "args": {...}} to look something up (you will get the result), or',
    answer === 'json' ? '{"done": {...your answer object...}} when you know enough.' : '{"done": "your answer"} when you know enough.',
    'Look up only what you need; at most a few lookups.',
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

async function lookup(task: AgentTask, call: { name: string; args: Record<string, unknown> }, calls: AgentCall[]): Promise<string> {
  if (calls.length >= task.maxCalls) return JSON.stringify({ error: 'No more lookups for this question: answer with what you have.' });
  if (!task.tools.includes(call.name as ToolName)) return JSON.stringify({ error: `${call.name} is not available. Use one of: ${task.tools.join(', ')}.` });
  if (call.name === 'open_link' && !linkKnown(String(call.args.url ?? ''), task, calls)) {
    return JSON.stringify({ error: 'Only links that appear in the items or in what you looked up can be opened. Copy the link exactly.' });
  }
  task.onLookup?.(call.name, call.args);
  const out = await runTool(call.name, call.args, task.ctx, task.signal);
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
  const specs = task.tools.map((n) => TOOL_SPECS[n]);
  for (let step = 1; step <= task.maxSteps; step++) {
    const last = step === task.maxSteps || calls.length >= task.maxCalls || left(task) < 6000;
    if (left(task) < 2500) throw new AgentTimeout('Out of time');
    const r = await modelStep(
      task.brain,
      {
        system: task.system,
        // the last turn has no tools: the lookups so far go in as plain text (every provider takes that)
        messages: last ? flatten(task.user, messages) : messages,
        tools: last ? undefined : specs,
        maxTokens: task.maxTokens ?? 700,
      },
      { signal: task.signal, timeoutMs: Math.max(2000, left(task) - 500) },
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
    const results = await Promise.all(toolCalls.map((c) => lookup(task, c, calls)));
    toolCalls.forEach((c, i) => messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: results[i]! }));
  }
  throw new Error('No answer within the step limit');
}

async function runJson(task: AgentTask, t0: number): Promise<AgentResult> {
  const system = `${task.system}\n\n${jsonProtocol(task.tools, task.answer)}`;
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: task.user }];
  const calls: AgentCall[] = [];
  for (let step = 1; step <= task.maxSteps; step++) {
    const last = step === task.maxSteps || calls.length >= task.maxCalls || left(task) < 6000;
    if (left(task) < 2500) throw new AgentTimeout('Out of time');
    const text = await generate(
      task.brain,
      {
        system,
        messages: last ? [...messages, { role: 'user', content: 'No more lookups: reply now with {"done": ...}.' }] : messages,
        json: true,
        maxTokens: task.maxTokens ?? 700,
      },
      { signal: task.signal, timeoutMs: Math.max(2000, left(task) - 500) },
    );
    const a = readAction(text);
    if (a.tool && !last) {
      const result = await lookup(task, { name: a.tool, args: a.args ?? {} }, calls);
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
  const mode = task.tools.length ? await toolMode(task.brain) : 'native';
  if (mode === 'json') return runJson(task, t0);
  try {
    return await runNative(task, t0);
  } catch (err) {
    if (!(err instanceof ToolsUnsupportedError)) throw err;
    await rememberMode(task.brain, 'json');
    return runJson(task, t0);
  }
}
