import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brain } from '../types';
import { hosts, NOW, packet, station } from './fixtures';
import { planBreak } from './planner';

vi.mock('../ai/generate', () => ({ generate: vi.fn(async () => 'Back with you on a ChatGPT-free night.') }));

const { writeBreak, writeMode } = await import('./writer');
const { generate } = await import('../ai/generate');
const { hasAi, showFallbackBanner } = await import('../ai/brains');

const ai: Brain = { id: 'b1', name: 'Local', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', transport: 'device', createdAt: 0, updatedAt: 0 };
const plan = () => planBreak(station(), packet(), [], { now: NOW, rand: () => 0 });

describe('no AI brain -> the scripted fallback speaks', () => {
  beforeEach(() => vi.mocked(generate).mockClear());

  it('hosts with no brain (null, the old built-in id, a deleted brain) get scripted lines and no model call', async () => {
    for (const brainId of [null, 'builtin', 'gone']) {
      const hs = hosts(2).map((h) => ({ ...h, brainId }));
      const brains = new Map<string, Brain>();
      expect(writeMode(hs, brains)).toBe('builtin');
      const out = await writeBreak({ station: station(), hosts: hs, brains, plan: plan(), packet: packet(), rand: () => 0.3 });
      expect(out.mode).toBe('builtin');
      expect(out.lines.length).toBeGreaterThan(0);
      expect(out.lines.map((l) => l.text).join(' ')).toMatch(/Midnight City|Dreams/);
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('a host with AI and one without take turns: only the AI host calls the model', async () => {
    const [maya, jules] = hosts(2);
    const hs = [{ ...maya!, brainId: ai.id }, { ...jules!, brainId: null }];
    const brains = new Map([[ai.id, ai]]);
    expect(writeMode(hs, brains)).toBe('turns');
    const out = await writeBreak({ station: station(), hosts: hs, brains, plan: { ...plan(), lines: 2 }, packet: packet(), rand: () => 0.3 });
    expect(out.lines.map((l) => l.hostId)).toEqual([maya!.id, jules!.id]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('the "reading scripted lines" banner', () => {
  const hs = hosts(2);
  it('shows while every host on the mic has no AI, until dismissed', () => {
    expect(showFallbackBanner(hs.map((h) => ({ ...h, brainId: null })), [], false)).toBe(true);
    expect(showFallbackBanner(hs.map((h) => ({ ...h, brainId: null })), [], true)).toBe(false);
    expect(showFallbackBanner([], [], false)).toBe(false);
  });

  it('hides once a host on the mic thinks with an AI; a deleted brain or an AI app connector does not count', () => {
    expect(showFallbackBanner([{ brainId: ai.id }, { brainId: null }], [ai], false)).toBe(false);
    expect(hasAi({ brainId: ai.id }, [ai])).toBe(true);
    expect(hasAi({ brainId: ai.id }, [])).toBe(false);
    expect(hasAi({ brainId: 'builtin' }, [{ id: 'builtin', kind: 'builtin' }])).toBe(false);
    expect(hasAi({ brainId: 'c1' }, [{ id: 'c1', kind: 'connector' }])).toBe(false);
  });
});
