// Writes a break: scripted fallback lines, one JSON script when all hosts share a brain, or turn by turn when they think
// with different brains (each host's brain sees the transcript so far).
import { FALLBACK_BRAIN, isFallback, realBrainId } from '../ai/brains';
import { generate } from '../ai/generate';
import type { Brain, BreakLine, ContextPacket, Host, Station } from '../types';
import { builtinTurn, writeBuiltinBreak } from './builtin';
import type { BreakPlan } from './planner';
import { buildScriptPrompt, buildTurnPrompt, scriptMaxTokens } from './prompt';
import { parseScript, parseTurn } from './script';

export interface WriteInput {
  station: Station;
  /** line-up order, lead first */
  hosts: Host[];
  /** brains by id (missing = the scripted fallback) */
  brains: Map<string, Brain>;
  plan: BreakPlan;
  packet: ContextPacket;
  signal?: AbortSignal;
  rand?: () => number;
  /** per model call (ms) */
  timeoutMs?: number;
}

export type WriteMode = 'builtin' | 'script' | 'turns';

export interface WrittenBreak {
  lines: BreakLine[];
  mode: WriteMode;
}

export const brainOf = (host: Host, brains: Map<string, Brain>): Brain => {
  const id = realBrainId(host.brainId);
  return (id && brains.get(id)) || FALLBACK_BRAIN;
};

export function writeMode(hosts: Host[], brains: Map<string, Brain>): WriteMode {
  const list = hosts.map((h) => brainOf(h, brains));
  if (list.every((b) => isFallback(b))) return 'builtin';
  if (list.every((b) => b.id === list[0]!.id)) return 'script';
  return 'turns';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Small models sometimes forget to introduce the next song: add a short intro to the last line. */
export function ensureIntro(lines: BreakLine[], plan: BreakPlan, packet: ContextPacket): BreakLine[] {
  const next = packet.songAfter;
  if (!plan.intro || !next || !lines.length) return lines;
  const title = norm(next.title);
  if (!title || lines.some((l) => norm(l.text).includes(title))) return lines;
  const last = lines[lines.length - 1]!;
  const intro = next.artist ? `Here's ${next.title} by ${next.artist}.` : `Here's ${next.title}.`;
  return [...lines.slice(0, -1), { ...last, text: `${last.text} ${intro}` }];
}

export async function writeBreak(input: WriteInput): Promise<WrittenBreak> {
  const { station, hosts, brains, plan, packet, signal } = input;
  const mode = writeMode(hosts, brains);
  if (mode === 'builtin') return { mode, lines: writeBuiltinBreak(station, hosts, plan, packet, { rand: input.rand }) };

  if (mode === 'script') {
    const brain = brainOf(hosts[0]!, brains);
    const prompt = buildScriptPrompt(station, hosts, plan, packet);
    const ask = () =>
      generate(
        brain,
        { system: prompt.system, messages: [{ role: 'user', content: prompt.user }], json: true, maxTokens: scriptMaxTokens(plan.lines, station.talkLength) },
        { signal, timeoutMs: input.timeoutMs },
      );
    let lines: BreakLine[];
    let raw = await ask();
    try {
      lines = parseScript(raw, hosts, plan.lines + 2);
    } catch (err) {
      // small local models now and then answer with nothing usable (an empty object, a lone brace): ask once more
      if (signal?.aborted || !/did not write any lines/.test(String(err))) throw err;
      console.warn('[hostcaster] unreadable script, asking the brain again:', raw.slice(0, 160));
      raw = await ask();
      lines = parseScript(raw, hosts, plan.lines + 2);
    }
    return { mode, lines: ensureIntro(lines, plan, packet) };
  }

  const transcript: BreakLine[] = [];
  for (let turn = 0; turn < plan.lines; turn++) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Break cancelled');
    const speaker = hosts[turn % hosts.length]!;
    const brain = brainOf(speaker, brains);
    try {
      let text: string;
      if (isFallback(brain)) text = builtinTurn(station, hosts, speaker, plan, packet, turn, { rand: input.rand });
      else {
        const p = buildTurnPrompt(station, hosts, speaker, plan, packet, transcript, turn);
        const raw = await generate(
          brain,
          { system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 220 },
          { signal, timeoutMs: input.timeoutMs },
        );
        text = parseTurn(raw, speaker, hosts, transcript.map((l) => l.text));
      }
      transcript.push({ hostId: speaker.id, text });
    } catch (err) {
      // a host dropped out mid-break: air what we have (two or more lines), else give up on this break
      if (transcript.length >= 2 && !signal?.aborted) break;
      throw err;
    }
  }
  return { mode, lines: ensureIntro(transcript, plan, packet) };
}
