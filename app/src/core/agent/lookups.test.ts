// Signed out, this device caps its own lookups; an AI-app question waits for its answer, then airs with it.
import { describe, expect, it } from 'vitest';
import { kvSet } from '../db';
import type { InboxItem } from '../types';
import { DEVICE_LOOKUPS_PER_DAY, deviceLookupsToday } from './lookups';
import { inboxForBreak, INBOX_ANSWER_WAIT_MS, isInboxQuestion } from './research';
import { runTool } from './tools';

const ctx = { connections: {}, units: 'metric' as const, headlines: [], purpose: 'research' as const };

describe('device lookups', () => {
  it('stop at the daily cap when no server counts them', async () => {
    const now = Date.now();
    await kvSet('agent:lookups', Array.from({ length: DEVICE_LOOKUPS_PER_DAY }, (_, i) => ({ at: now - i * 1000, tool: 'weather', what: 'Weather: Tampa, today', ok: true })));
    expect(await deviceLookupsToday()).toBe(DEVICE_LOOKUPS_PER_DAY);
    const r = await runTool('weather', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.what).toBe('weather (daily limit)');
    await kvSet('agent:lookups', []);
  });
});

describe('questions from the AI app', () => {
  const at = Date.now();
  const q: InboxItem = { id: 'q1', kind: 'note', text: "What's on my calendar with Dana this week?", createdAt: at } as InboxItem;
  const note: InboxItem = { id: 'n1', kind: 'note', text: 'Sam is on vacation next week.', createdAt: at } as InboxItem;
  it('a question waits for its answer; a plain note airs at once; an answer rides along', async () => {
    expect(isInboxQuestion(q)).toBe(true);
    expect(isInboxQuestion(note)).toBe(false);
    let r = await inboxForBreak([q, note], at + 1000);
    expect(r.inbox?.map((i) => i.id)).toEqual(['n1']);
    r = await inboxForBreak([q, note], at + INBOX_ANSWER_WAIT_MS + 1);
    expect(r.inbox?.map((i) => i.id)).toEqual(['q1', 'n1']);
    await kvSet('agent:answers', { q1: { question: q.text, answer: 'The Q4 budget review on Monday at 2.', found: true, sources: [], by: 'ai', ms: 900, lookups: 1 } });
    r = await inboxForBreak([q, note], at + 1000);
    expect(r.inbox?.map((i) => i.id)).toEqual(['q1', 'n1']);
    expect(r.answers.q1?.answer).toBe('The Q4 budget review on Monday at 2.');
  });
});
