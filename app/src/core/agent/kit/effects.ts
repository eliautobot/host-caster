// A turn's effects as code's exact words: what was done (the done or failed line) and what waits for a yes (the
// read-back, last). The model's own lines only react around them (actions/echo.ts drops repeats and early claims).
import { askLine, doneLine, failedLine, googleZone, type ActionTurn } from '../../actions/callin';
import type { ActionRecord } from '../../actions/types';
import type { Effect } from './types';

/** Two read-backs in one: "Just to check: A And: B Should I go ahead with both? ..." */
function askBoth(a: ActionRecord, b: ActionRecord, tz?: string): string {
  const strip = (line: string) => line.replace(/^Just to check: /, '').replace(/ Should I go ahead\? Just say yes or no\.$/, '');
  return `Just to check: ${strip(askLine(a, tz))} And: ${strip(askLine(b, tz))} Should I go ahead with both? Just say yes or no.`;
}

/** The exact closing words and the ActionTurn the break writer and the echo filter read; undefined = nothing to say. */
export async function effectsTurn(effects: Effect[]): Promise<ActionTurn | undefined> {
  const asked = effects.filter((e): e is Extract<Effect, { kind: 'asked' }> => e.kind === 'asked').map((e) => e.action);
  const ran = effects.filter((e): e is Extract<Effect, { kind: 'ran' }> => e.kind === 'ran').map((e) => e.action);
  const cancelled = effects.filter((e) => e.kind === 'cancelled');
  const said = effects.filter((e): e is Extract<Effect, { kind: 'said' }> => e.kind === 'said');
  if (!asked.length && !ran.length && !cancelled.length && !said.length) return undefined;
  const needsZone = [...asked, ...ran].some((a) => a.type === 'calendar.add');
  const tz = needsZone ? await googleZone().catch(() => undefined) : undefined;
  const lines: string[] = [];
  const facts: string[] = [];
  for (const a of ran) {
    lines.push(a.status === 'done' ? doneLine(a, tz) : failedLine(a));
    facts.push(a.status === 'done' ? `ACTION DONE: ${a.summary}` : `ACTION FAILED, nothing changed: ${a.summary}`);
  }
  if (cancelled.length) {
    lines.push('Okay, I will leave that alone.');
    facts.push('ACTION: the listener said no, so nothing was done.');
  }
  for (const s of said) {
    lines.push(s.line);
    facts.push(s.fact);
  }
  if (asked.length) {
    lines.push(asked.length > 1 ? askBoth(asked[0]!, asked[1]!, tz) : askLine(asked[0]!, tz));
    facts.push(...asked.map((a) => `ACTION WAITING FOR A YES (not done): ${a.summary}`));
  }
  const kind: ActionTurn['kind'] = asked.length ? 'asked' : ran.some((a) => a.status === 'done') ? 'done' : ran.length ? 'failed' : cancelled.length ? 'cancelled' : 'held';
  return { kind, fact: facts.join(' '), line: lines.join(' '), action: asked[0] ?? ran[0] };
}
