// Deferred tools (docs/AGENT.md, section 1): a turn sends the model the full schemas of a few tools only; every other
// usable tool is a name in the self-knowledge directory (one line per area) and find_tools loads its schema on
// demand, in the same turn, with native tool calls and the JSON way alike. The same idea as tool search and
// deferred tools in agent frameworks: the prompt stays small however many tools the sources (built-in, MCP, plug-ins) bring,
// and every tool still goes through the same availability, policy and approval checks.
//
// Sent with every turn, in the same order every turn (the "loaded" set):
//   - core tools: a source marks the ones most turns need (the main look-ups and the everyday changes);
//   - what answers what is pending: the approvals and undo_change (code still checks every use);
//   - then what this conversation loaded with find_tools or used, appended in that order (it stays loaded).
// The set only grows during a conversation and the self-knowledge does not change with it: a model provider caches a
// prompt whose tools and system text are exactly the same as last time (about a tenth of the price, and sooner), so
// a turn never reshuffles the tools to fit the listener's words; find_tools is how a turn gets one it lacks.
// A small toolbox (schemas under SMALL_CHARS together) goes whole: deferring only pays when there is a lot.
import type { KitTool } from '../loop';
import type { OfferedTool, OffTool, Toolbox } from './types';

export const FIND_TOOLS = 'find_tools';
export const KEEP_MAX = 12;
export const SMALL_CHARS = 6000;
const FIND_MAX = 5;

/** What the turn sends now and what waits in the directory. */
export interface ToolPlan {
  /** names whose full schemas go with the first model step, in the order they are sent */
  sent: Set<string>;
  /** offered tools the model can load with find_tools (or call by name) */
  deferred: OfferedTool[];
  /** offered tools not sent unless loaded (the directory's [names]: the same every turn of a conversation) */
  later: Set<string>;
}

export interface PlanInput {
  /** tools this conversation loaded or used, in that order (they stay loaded) */
  keep?: Iterable<string>;
}

// ---- the search: plain words against each tool's name, title, area, keywords and description (IDF weighted) ---------

const STOP = new Set(
  'a an the to of in on at for and or my me i im you your it its is are was be can could would will please that this these those with from by as so just what which there here we our us he she they them his her their do does have has had get got some any all one want need'.split(' '),
);

const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w);

export function words(text: string): string[] {
  return (text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

type Doc = { tool: OfferedTool['tool']; terms: Map<string, number> };

function doc(tool: OfferedTool['tool']): Doc {
  const terms = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const w of words(text)) terms.set(w, Math.max(terms.get(w) ?? 0, weight));
  };
  add(tool.description, 1);
  add(tool.group, 2);
  add((tool.keywords ?? []).join(' '), 2);
  add(tool.title, 3);
  add(tool.name.replace(/_/g, ' '), 3);
  return { tool, terms };
}

/**
 * The tools that fit some words, best first: `recent` is the listener's words newest first (older lines count less),
 * scored like a search engine (a word most tools share counts little). Only tools with a real match come back.
 */
export function rankTools<T extends { tool: OfferedTool['tool'] }>(list: T[], recent: string[], min = 1.2): { item: T; score: number }[] {
  if (!list.length) return [];
  const docs = list.map((item) => ({ item, d: doc(item.tool) }));
  const df = new Map<string, number>();
  for (const { d } of docs) for (const t of d.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const query = new Map<string, number>();
  recent.slice(0, 3).forEach((line, i) => {
    const weight = [1, 0.5, 0.3][i]!;
    for (const w of words(line)) query.set(w, Math.max(query.get(w) ?? 0, weight));
  });
  return docs
    .map(({ item, d }) => {
      let score = 0;
      for (const [w, qw] of query) {
        const tw = d.terms.get(w);
        if (tw) score += qw * tw * Math.log(1 + docs.length / (df.get(w) ?? 1));
      }
      return { item, score };
    })
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score);
}

// ---- the plan for one turn -------------------------------------------------------------------------------------------

const specChars = (o: OfferedTool) => o.tool.name.length + o.tool.description.length + JSON.stringify(o.tool.parameters).length;

export function planTools(box: Pick<Toolbox, 'offered'>, input: PlanInput = {}): ToolPlan {
  const usable = box.offered;
  if (usable.reduce((n, o) => n + specChars(o), 0) <= SMALL_CHARS) return { sent: new Set(usable.map((o) => o.tool.name)), deferred: [], later: new Set() };
  const sent = new Set<string>();
  for (const o of usable) if (o.tool.core || o.tool.firstStepOnly || o.tool.name === 'undo_change') sent.add(o.tool.name);
  const later = new Set(usable.filter((o) => !sent.has(o.tool.name)).map((o) => o.tool.name));
  for (const n of [...(input.keep ?? [])].slice(0, KEEP_MAX)) if (later.has(n)) sent.add(n);
  return { sent, deferred: usable.filter((o) => !sent.has(o.tool.name)), later };
}

// ---- find_tools ----------------------------------------------------------------------------------------------------

export const FIND_SPEC = {
  name: FIND_TOOLS,
  description:
    'Only for a tool that is NOT in your tool list (a name in [brackets] under WHAT YOU CAN DO): loads it by name or by what you need, and it works right away in this turn. Never for a tool you already have.',
  parameters: {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string' }, description: 'tool names from the [brackets]' },
      need: { type: 'string', description: 'what you want to do, in a few words ("delete a Google task")' },
    },
    required: [],
  },
};

/** The discovery tool for one turn: loads deferred tools (their schemas come back, and they are sent from now on). */
export function findTools(plan: ToolPlan, off: OffTool[], onLoad: (names: string[]) => void): KitTool {
  return {
    spec: FIND_SPEC,
    discovery: true,
    async run(args, at) {
      const asked = Array.isArray(args.names) ? args.names.map((n) => String(n).trim()).filter(Boolean).slice(0, 10) : typeof args.names === 'string' ? [args.names] : [];
      const need = typeof args.need === 'string' ? args.need.slice(0, 200) : '';
      const pick = new Map<string, OfferedTool>();
      for (const n of asked) {
        const o = plan.deferred.find((d) => d.tool.name === n);
        if (o) pick.set(n, o);
      }
      const query = [need, asked.filter((n) => !pick.has(n)).join(' ').replace(/_/g, ' ')].filter(Boolean);
      if (query.length) for (const { item } of rankTools(plan.deferred, query, 0.5).slice(0, FIND_MAX)) if (pick.size < FIND_MAX + asked.length) pick.set(item.tool.name, item);
      const loaded = [...pick.values()];
      const names = loaded.map((o) => o.tool.name);
      if (names.length) {
        at.load(names);
        onLoad(names);
      }
      const already = asked.filter((n) => plan.sent.has(n));
      const unknown = asked.filter((n) => !pick.has(n) && !plan.sent.has(n) && !plan.deferred.some((d) => d.tool.name === n) && !off.some((o) => o.tool.name === n));
      const offHits = rankTools(off, query.length ? query : asked, 0.5)
        .slice(0, 3)
        .map(({ item }) => ({ tool: item.tool.title, why_off: item.reason, how_to_turn_on: item.fix }));
      const content = {
        loaded: loaded.map((o) => ({
          name: o.tool.name,
          description: o.tool.description,
          parameters: o.tool.parameters,
          ...(o.tool.kind === 'outside-write' ? { asks_first: o.policy !== 'auto' || o.tool.level === 3 } : {}),
        })),
        ...(already.length ? { already_in_your_tools: already, note_on_those: 'You already have these: call them now, no loading needed.' } : {}),
        ...(unknown.length ? { no_such_tool: unknown } : {}),
        ...(offHits.length ? { switched_off: offHits } : {}),
        note: names.length ? 'Loaded: call them now, in this turn.' : already.length ? 'Call the tool now.' : 'Nothing more fits: use the tools you have, or say plainly what you cannot do.',
      };
      return { ok: names.length > 0, content: JSON.stringify(content), what: names.length ? `Tools: ${names.join(', ')}` : 'Tools: none fit' };
    },
  };
}
