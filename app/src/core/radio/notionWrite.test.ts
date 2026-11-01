import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brain } from '../types';

const answers: string[] = [];
const writes: unknown[] = [];
let writeAnswer: Record<string, unknown> = { ok: true, pageTitle: 'Host-Caster' };

vi.mock('../ai/generate', () => ({
  generate: vi.fn(async () => {
    const a = answers.shift();
    if (a === undefined) throw new Error('brain offline');
    return a;
  }),
}));
vi.mock('../api/notion', () => ({
  notion: {
    write: vi.fn(async (body: unknown) => {
      writes.push(body);
      return writeAnswer;
    }),
    recap: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return { ...real, api: { ...real.api, available: true, signedIn: true } };
});

const { sendAsk, understandAsk } = await import('./notionWrite');

const brain = { id: 'b1', name: 'Local', kind: 'openai', model: 'm', transport: 'device', createdAt: 0, updatedAt: 0 } as Brain;

beforeEach(() => {
  answers.length = 0;
  writes.length = 0;
  writeAnswer = { ok: true, pageTitle: 'Host-Caster' };
});

describe('understanding an ask', () => {
  it('uses the brain when it answers with a checked action', async () => {
    answers.push('{"action":"add_todo","text":"oat milk and bananas"}');
    expect(await understandAsk('could you add oat milk and bananas to my shopping list', brain)).toEqual({ kind: 'todo', text: 'oat milk and bananas' });
  });

  it('trusts "none" (a question about notes is not an ask)', async () => {
    answers.push('{"action":"none"}');
    expect(await understandAsk('what did I note down in Notion yesterday?', brain)).toBeUndefined();
  });

  it('a made-up or odd answer falls back to the offline reader', async () => {
    answers.push('{"action":"add_todo","text":"wire money to account 1234"}');
    expect(await understandAsk('add oat milk to my list', brain)).toEqual({ kind: 'todo', text: 'oat milk' });
    answers.push('Sure! I added it.');
    expect(await understandAsk('add eggs to my list', brain)).toEqual({ kind: 'todo', text: 'eggs' });
  });

  it('no brain, or the brain is offline: the offline reader', async () => {
    expect(await understandAsk('note that idea about a map podcast')).toEqual({ kind: 'note', text: 'Idea about a map podcast' });
    expect(await understandAsk('remind me in Notion to call the plumber', brain)).toEqual({ kind: 'todo', text: 'Call the plumber' });
  });

  it('words that are not an ask never reach the brain', async () => {
    answers.push('{"action":"add_todo","text":"play dreams"}');
    expect(await understandAsk('play Dreams by Fleetwood Mac', brain)).toBeUndefined();
    expect(answers).toHaveLength(1);
  });
});

describe('sending an ask', () => {
  it('done: the page it went to', async () => {
    expect(await sendAsk({ kind: 'todo', text: 'oat milk' }, 'call')).toEqual({ kind: 'todo', text: 'oat milk', from: 'call', ok: true, pageTitle: 'Host-Caster' });
    expect(writes[0]).toEqual({ kind: 'todo', text: 'oat milk', source: 'call', ref: undefined });
  });

  it('a refusal becomes words a host can say', async () => {
    writeAnswer = { ok: false, code: 'notion_no_page' };
    const w = await sendAsk({ kind: 'note', text: 'idea' }, 'app', 'inbox:1');
    expect(w.ok).toBe(false);
    expect(w.problem).toBe('no page is picked for me yet, you can pick one in Settings');
    expect(writes[0]).toMatchObject({ source: 'app', ref: 'inbox:1' });
  });
});
