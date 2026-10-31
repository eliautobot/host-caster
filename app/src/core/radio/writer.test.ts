import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brain } from '../types';
import { hosts, NOW, packet, station } from './fixtures';
import { planBreak } from './planner';

const answers: string[] = [];
vi.mock('../ai/generate', () => ({ generate: vi.fn(async () => answers.shift() ?? '') }));

const { writeBreak } = await import('./writer');
const { generate } = await import('../ai/generate');

const brain: Brain = { id: 'b1', name: 'Local', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', transport: 'device', createdAt: 0, updatedAt: 0 };

describe('writeBreak (one script for all hosts)', () => {
  beforeEach(() => {
    answers.length = 0;
    vi.mocked(generate).mockClear();
  });

  const run = () => {
    const hs = hosts(2).map((h) => ({ ...h, brainId: brain.id }));
    const p = packet();
    const plan = planBreak(station(), p, [], { now: NOW, rand: () => 0 });
    return writeBreak({ station: station(), hosts: hs, brains: new Map([[brain.id, brain]]), plan, packet: p });
  };

  it('asks once more when the first answer has no lines in it', async () => {
    answers.push('{}', '{"lines":[{"host":"Maya","text":"That was Midnight City."},{"host":"Jules","text":"Here is Dreams by Fleetwood Mac."}]}');
    const out = await run();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(out.lines.map((l) => l.text)).toEqual(['That was Midnight City.', 'Here is Dreams by Fleetwood Mac.']);
  });

  it('gives up after the second unreadable answer', async () => {
    answers.push('{}', '[]');
    await expect(run()).rejects.toThrow(/did not write any lines/);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
