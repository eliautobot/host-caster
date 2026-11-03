// The hosts' tool kit (docs/AGENT.md): what a tool is, where tools come from, and what a turn knows. Every tool is
// rebuilt each turn from what this account connected and allowed; writes are checked by code, never by the model.
import type { ActionRecord, ActionsStatus } from '../../actions/types';
import type { MemoryChange } from '../../memory/commands';
import type { NotionWrite } from '../../radio/notionAsk';
import type { SongRequest } from '../../radio/requests';
import type { Connections, ToolSpec } from '../../types';
import type { ServerAgentStatus, ToolContext } from '../tools';

/**
 * read = looks something up; app-write = changes only Host-Caster's own data (runs at once, can be undone);
 * outside-write = changes another account (only proposes: the listener says yes, the app runs it).
 */
export type ToolKind = 'read' | 'app-write' | 'outside-write';

/** The listener's choice per tool (Settings, Connections, What your hosts can do). */
export type Policy = 'auto' | 'ask' | 'off';

/**
 * call / chat / call-in = the listener is talking (listener turns); ai-app = a note from the listener's own AI app;
 * background = breaks, research, heads-ups (read only).
 */
export type TurnKind = 'call' | 'chat' | 'call-in' | 'ai-app' | 'background';

export const LISTENER_TURNS: readonly TurnKind[] = ['call', 'chat', 'call-in'];
export const isListenerTurn = (t: TurnKind) => LISTENER_TURNS.includes(t);

export type OffReason = 'signed-out' | 'offline' | 'not-connected' | 'missing-permission' | 'switched-off' | 'no-brain' | 'not-here' | 'unavailable';

export type Availability = { ok: true } | { ok: false; reason: OffReason; fix: string };

export const OK: Availability = { ok: true };
export const off = (reason: OffReason, fix: string): Availability => ({ ok: false, reason, fix });

/** The music under the hosts: play-next is only possible with the app's own player. */
export interface MusicHooks {
  /** true, or why songs cannot be queued now ("another music app is playing") */
  canQueue(): true | string;
  /** queue a song by words or by track id to play next */
  queue(query: string, trackId?: string): Promise<SongRequest | undefined>;
}

/** What a turn knows about this account right now (read fresh every turn, kit/env.ts). */
export interface AgentEnv {
  turn: TurnKind;
  online: boolean;
  signedIn: boolean;
  connections: Connections;
  /** the server's services for this account; undefined = signed out or not reachable */
  server?: ServerAgentStatus['tools'];
  /** Google permissions granted (write scopes) */
  google?: ActionsStatus;
  hasBrain: boolean;
  music?: MusicHooks;
  /** for the look-ups (place, units, headlines, the Lookups log) */
  ctx: ToolContext;
}

/** One app change the listener can undo (kit/changes.ts). */
export interface AppChange {
  id: string;
  what: string;
  at: number;
}

/** What a tool made happen, for code's exact lines after the reply (kit/effects.ts). */
export type Effect =
  | { kind: 'asked'; action: ActionRecord }
  | { kind: 'ran'; action: ActionRecord }
  | { kind: 'cancelled'; action: ActionRecord }
  | { kind: 'changed'; change: AppChange }
  | { kind: 'song'; request: SongRequest }
  | { kind: 'memory'; change: MemoryChange }
  | { kind: 'notion'; write: NotionWrite }
  /** code's own words the reply ends with when nothing could be done (an invitation Google holds in the mail) */
  | { kind: 'said'; line: string; fact: string };

/** What a tool's run knows: the turn, which model step this is, and what has happened in it so far. */
export interface RunInfo {
  env: AgentEnv;
  /** 1-based model step of this turn */
  step: number;
  /** a tool result (an email, a page, a note ...) is already in the model's context */
  seenResults: boolean;
  /** the listener's words in this turn ('' when nobody spoke) */
  said: string;
  /** what the listener said in this conversation (their own words only): writes must be made of these */
  heard: string;
  /** epoch ms the turn started: a proposal made before it was read back to the listener */
  startedAt: number;
  effects: Effect[];
  /** the listener's policy for the tool being run */
  policy: Policy;
  signal?: AbortSignal;
}

export interface ToolRun {
  ok: boolean;
  /** what goes back to the model (an object becomes JSON) */
  content: string | Record<string, unknown>;
  /** a few words for the Lookups log */
  what: string;
  effect?: Effect | Effect[];
  /**
   * code's own words when the job is finished and the model need not say anything more ("Got it, I'll remember that
   * you like jazz."): a step whose tools all finished this way ends the turn with these words (or the model's own,
   * when it spoke with its tool calls). Left out when the model should still act on the result.
   */
  said?: string;
}

export interface AgentTool {
  name: string;
  /** plain words for Settings ("Delete a task") */
  title: string;
  /** what it belongs to ("Google Tasks") */
  group: string;
  /** what the model reads */
  description: string;
  /** JSON Schema of the arguments (an object) */
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** outside writes: 2 = only the listener sees it, 3 = other people see it */
  level?: 2 | 3;
  /** the choices Settings offers; [] = fixed (always on while available) */
  policies?: Policy[];
  /** default when the listener never chose */
  defaultPolicy?: Policy;
  /** offered only in listener turns, and only on a turn's first model step before any tool result (approvals) */
  firstStepOnly?: boolean;
  /** most turns need it: its full schema goes with every turn (the rest load on demand, kit/discover.ts) */
  core?: boolean;
  /** words a listener might use for it ("finished", "take off"), for finding it by what was said */
  keywords?: string[];
  available(env: AgentEnv): Availability | Promise<Availability>;
  run(args: Record<string, unknown>, run: RunInfo): Promise<ToolRun>;
}

/** Where tools come from: the built-in source now; an MCP source or a plug-in later, the same way. */
export interface ToolSource {
  id: string;
  tools(env: AgentEnv): AgentTool[] | Promise<AgentTool[]>;
}

export interface OfferedTool {
  tool: AgentTool;
  source: string;
  policy: Policy;
}

export interface OffTool {
  tool: AgentTool;
  source: string;
  reason: OffReason;
  fix: string;
}

/** One turn's tools: what the model gets, and what exists but is off (for self-knowledge and Settings). */
export interface Toolbox {
  env: AgentEnv;
  offered: OfferedTool[];
  off: OffTool[];
  get(name: string): OfferedTool | undefined;
  specs(): ToolSpec[];
}
