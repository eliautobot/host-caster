// Break preparation timing: ready at the first clip, the rest voiced in parallel, slow or failed voices stand in;
// local brains are woken when a station goes on air.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brain, Host, VoiceClip } from '../types';
import { hosts, packet, station } from './fixtures';

const lineup = hosts(2).map((h, i) => ({ ...h, brainId: i === 0 ? 'local' : 'cloud', voice: { ...h.voice, voiceProviderId: 'v1', voiceId: 'x' } }));
const brains: Record<string, Brain> = {
  local: { id: 'local', name: 'Ollama', kind: 'openai', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'm', transport: 'device', createdAt: 0, updatedAt: 0 },
  cloud: { id: 'cloud', name: 'OpenAI', kind: 'openai', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', transport: 'device', createdAt: 0, updatedAt: 0 },
};

vi.mock('../db', () => ({ getHost: async (id: string) => lineup.find((h) => h.id === id) }));
vi.mock('../ai/brains', async (orig) => ({ ...(await orig<typeof import('../ai/brains')>()), resolveBrain: async (id: string) => brains[id] }));
vi.mock('../context/context', () => ({ buildContext: async () => packet(), summarize: (t: unknown) => t }));
vi.mock('../ai/generate', () => ({
  generate: vi.fn(async () => JSON.stringify({ lines: [1, 2, 3, 4, 5].map((n) => ({ host: n % 2 ? 'Maya' : 'Jules', text: `Line ${n} about Midnight City.` })) })),
}));
const voiced: { text: string; at: number }[] = [];
let voiceMs = (_i: number) => 0;
vi.mock('../voice/voice', () => ({
  speak: vi.fn(async (host: Host, text: string): Promise<VoiceClip> => {
    if (host.voice.voiceProviderId === 'device') return { kind: 'device', text, voiceId: '', rate: 1, pitch: 1 };
    const i = Number(/Line (\d)/.exec(text)?.[1] ?? 0);
    voiced.push({ text, at: Date.now() });
    await new Promise((r) => setTimeout(r, voiceMs(i)));
    if (i === 3) throw new Error('voice server hiccup');
    return { kind: 'audio', blob: new Blob([text]) };
  }),
}));

const { prepareBreak, warmUpBrains } = await import('./prepare');
const { generate } = await import('../ai/generate');

describe('prepareBreak timing', () => {
  beforeEach(() => {
    voiced.length = 0;
    vi.mocked(generate).mockClear();
  });

  it('is ready at the first clip; all lines are voiced in parallel; a failed voice gives the device voice', async () => {
    const st = station({ hostIds: lineup.map((h) => h.id), talkLength: 'long' });
    lineup.forEach((h) => (h.brainId = 'cloud'));
    voiceMs = (i) => (i === 1 ? 50 : 400); // a slow cloud voice: line 1 quick, the rest slow
    const t0 = Date.now();
    const b = await prepareBreak({ station: st, kind: 'regular' });
    const readyMs = Date.now() - t0;
    expect(readyMs).toBeLessThan(300); // did not wait for the slow ones
    expect(b.clips[0]).toMatchObject({ kind: 'audio' });
    expect(b.clips.slice(1).every((c) => c instanceof Promise)).toBe(true);
    // the first four requests went out together (not two at a time)
    expect(voiced.slice(0, 4).every((v) => v.at - voiced[0]!.at < 50)).toBe(true);
    const all = await Promise.all(b.clips);
    expect(all.map((c) => c.kind)).toEqual(['audio', 'audio', 'device', 'audio', 'audio']);
    expect(b.standInFor?.voice).toBe(true);
  });

  it('a deadline squeezes the brain budget (a short song left)', async () => {
    const st = station({ hostIds: lineup.map((h) => h.id) });
    voiceMs = () => 0;
    await prepareBreak({ station: st, kind: 'regular', deadline: Date.now() + 20_000 });
    const opts = vi.mocked(generate).mock.calls[0]![2] as { timeoutMs?: number };
    expect(opts.timeoutMs).toBe(12_000);
  });
});

describe('warmUpBrains', () => {
  it('wakes local models once, never cloud ones', async () => {
    lineup[0]!.brainId = 'local';
    lineup[1]!.brainId = 'cloud';
    vi.mocked(generate).mockClear();
    const st = station({ hostIds: lineup.map((h) => h.id) });
    await warmUpBrains(st);
    await warmUpBrains(st);
    expect(vi.mocked(generate).mock.calls.map((c) => (c[0] as Brain).id)).toEqual(['local']);
  });
});
