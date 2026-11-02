// One model turn with tools, for every brain kind: OpenAI-compatible and Anthropic on the device, everything else
// through the Host-Caster server (/api/ai/chat takes tools: OpenAI-compatible, Anthropic, Host-Caster AI, ChatGPT
// plan) or the desktop helper (ChatGPT plan on that computer). A model or server that does not take tools answers
// ToolsUnsupportedError; the loop then asks that brain the JSON way.
import { aiProxy, api, ApiError } from '../api';
import { helperRequest } from '../api/helper';
import { headers as anthropicHeaders, base as anthropicBase } from '../ai/anthropic';
import { isFallback } from '../ai/brains';
import { NoModelError } from '../ai/generate';
import { mergeSignal, postJson, ProviderError, joinUrl, type FetchOpts } from '../ai/http';
import { headers as openaiHeaders, isOllama, stripThinking } from '../ai/openai';
import { isDesktop } from '../native/desktop';
import type { AgentMessage, Brain, ToolCall, ToolSpec } from '../types';

export class ToolsUnsupportedError extends Error {
  override name = 'ToolsUnsupportedError';
}

export interface StepRequest {
  system: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
}

const TOOLS_REFUSED = /tool|function[_ ]call|functions? (are|is) not supported|does not support (tools|functions)/i;

let callSeq = 0;
const newId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const s = String(raw ?? '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- OpenAI-compatible on the device ------------------------------------------------------------------------------

interface OpenAIMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  reasoning?: string;
  reasoning_content?: string;
}

export function toOpenAIMessages(messages: AgentMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function fromOpenAIToolCalls(message: OpenAIMessage | undefined): ToolCall[] {
  return (message?.tool_calls ?? [])
    .filter((c) => c?.function?.name)
    .slice(0, 8)
    .map((c) => ({ id: c.id || newId(), name: String(c.function!.name), args: parseArgs(c.function!.arguments) }));
}

async function openaiStep(brain: Brain, req: StepRequest, fo: FetchOpts): Promise<StepResult> {
  if (!brain.baseUrl) throw new ProviderError('This brain has no server address');
  const tokenKey = brain.preset === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const body: Record<string, unknown> = {
    model: brain.model,
    messages: [{ role: 'system', content: req.system }, ...toOpenAIMessages(req.messages)],
    [tokenKey]: req.maxTokens,
    stream: false,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (brain.temperature !== undefined) body.temperature = brain.temperature;
  if (isOllama(brain)) body.reasoning_effort = 'none';
  if (brain.preset === 'openrouter' || /^https:\/\/openrouter\.ai\//.test(brain.baseUrl)) body.reasoning = { enabled: false };
  const url = joinUrl(brain.baseUrl, 'chat/completions');
  type Res = { choices?: { message?: OpenAIMessage; finish_reason?: string }[] };
  let res: Res;
  try {
    res = await postJson<Res>(url, body, openaiHeaders(brain), fo);
  } catch (err) {
    if (err instanceof ProviderError && req.tools?.length && (err.status === 400 || err.status === 404 || err.status === 422 || err.status === 500) && TOOLS_REFUSED.test(err.message)) {
      throw new ToolsUnsupportedError(err.message);
    }
    if (err instanceof ProviderError && err.status === 400 && /temperature|reasoning/i.test(err.message)) {
      delete body.temperature;
      delete body.reasoning_effort;
      delete body.reasoning;
      res = await postJson<Res>(url, body, openaiHeaders(brain), fo);
    } else throw err;
  }
  const message = res.choices?.[0]?.message;
  const toolCalls = req.tools?.length ? fromOpenAIToolCalls(message) : [];
  const text = stripThinking(typeof message?.content === 'string' ? message.content : '');
  return { text, toolCalls };
}

// ---- Anthropic on the device --------------------------------------------------------------------------------------

type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string };

export function toAnthropicMessages(messages: AgentMessage[]): { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(nothing)' };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} }))],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: 'Go ahead.' });
  return out;
}

async function anthropicStep(brain: Brain, req: StepRequest, fo: FetchOpts): Promise<StepResult> {
  const body: Record<string, unknown> = { model: brain.model, max_tokens: req.maxTokens, system: req.system, messages: toAnthropicMessages(req.messages) };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (brain.temperature !== undefined) body.temperature = Math.min(1, brain.temperature);
  let res: { content?: AnthropicBlock[] };
  try {
    res = await postJson<{ content?: AnthropicBlock[] }>(joinUrl(anthropicBase(brain), 'v1/messages'), body, anthropicHeaders(brain), fo);
  } catch (err) {
    if (err instanceof ProviderError && req.tools?.length && err.status === 400 && TOOLS_REFUSED.test(err.message)) throw new ToolsUnsupportedError(err.message);
    throw err;
  }
  const blocks = res.content ?? [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim(),
    toolCalls: blocks.filter((b) => b.type === 'tool_use' && b.name).slice(0, 8).map((b) => ({ id: b.id || newId(), name: b.name!, args: parseArgs(b.input) })),
  };
}

// ---- dispatch ------------------------------------------------------------------------------------------------------

const viaHelper = (brain: Brain) => isDesktop && brain.kind === 'chatgpt';
const viaServer = (brain: Brain) => brain.transport === 'server' || brain.kind === 'chatgpt' || brain.kind === 'hostcaster';

/** A model reached through the server that the server says takes no tools. */
const refused = (err: unknown) => err instanceof ApiError && err.code === 'tools_unsupported';

export async function modelStep(brain: Brain, req: StepRequest, opts: FetchOpts = {}): Promise<StepResult> {
  if (isFallback(brain) || brain.kind === 'builtin') throw new NoModelError('No AI brain');
  if (brain.kind === 'connector') throw new NoModelError(`${brain.name} sends notes; it does not answer`);
  const fo: FetchOpts = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 45_000 };
  try {
    if (viaHelper(brain)) {
      const r = await helperRequest<{ text: string; toolCalls?: ToolCall[] }>(
        'POST',
        '/api/ai/chat',
        { brain: { kind: brain.kind, model: brain.model }, system: req.system, messages: req.messages, tools: req.tools },
        { timeoutMs: fo.timeoutMs, signal: mergeSignal(fo) },
      );
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    }
    if (viaServer(brain)) {
      if (!api.session || !api.available) throw new ProviderError(`${brain.name} runs through your Host-Caster server, which is not reachable`);
      const r = await aiProxy.chat(
        { brainId: brain.id, system: req.system, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens },
        { signal: mergeSignal(fo), brain: { ...brain, transport: 'server' } },
      );
      return { text: stripThinking(r.text ?? ''), toolCalls: r.toolCalls ?? [] };
    }
    if (brain.kind === 'anthropic') return await anthropicStep(brain, req, fo);
    return await openaiStep(brain, req, fo);
  } catch (err) {
    if (req.tools?.length && refused(err)) throw new ToolsUnsupportedError((err as Error).message);
    throw err;
  }
}
