// "What your hosts can do" (Settings, Connections): the same registry the hosts get every turn, as a list for the
// listener: each tool with its policy, the choices, and why it is off and how to turn it on.
import { stationHost } from '../../radio/notionWrite';
import { getSettings, getStation } from '../../db';
import { loadEnv } from './env';
import { choices, policyOf } from './policy';
import { allTools, availability } from './registry';
import './sources';
import type { MusicHooks, OffReason, Policy, ToolKind } from './types';

export interface CanDoTool {
  name: string;
  title: string;
  kind: ToolKind;
  level?: 2 | 3;
  policy: Policy;
  choices: Policy[];
  /** usable now (policy aside) */
  ok: boolean;
  reason?: OffReason;
  fix?: string;
}

export interface CanDoGroup {
  group: string;
  tools: CanDoTool[];
}

export interface CanDo {
  groups: CanDoGroup[];
  /** the station's hosts have a real AI brain (without one they only take plain commands) */
  brain: boolean;
}

export async function hostsCanDo(music?: MusicHooks): Promise<CanDo> {
  const settings = await getSettings();
  const station = settings.activeStationId ? await getStation(settings.activeStationId).catch(() => undefined) : undefined;
  const lead = station ? await stationHost(station).catch(() => undefined) : undefined;
  const env = await loadEnv({ turn: 'call', hasBrain: Boolean(lead), music, ctx: { connections: settings.connections, units: 'metric', headlines: [], purpose: 'call-in' } });
  const groups = new Map<string, CanDoTool[]>();
  for (const { tool } of await allTools(env)) {
    if (tool.firstStepOnly) continue; // approvals are how a yes works, not a choice
    const a = await availability(tool, env);
    const row: CanDoTool = { name: tool.name, title: tool.title, kind: tool.kind, ...(tool.level ? { level: tool.level } : {}), policy: policyOf(tool, settings.connections), choices: choices(tool), ok: a.ok, ...(a.ok ? {} : { reason: a.reason, fix: a.fix }) };
    groups.set(tool.group, [...(groups.get(tool.group) ?? []), row]);
  }
  return { groups: [...groups].map(([group, tools]) => ({ group, tools })), brain: Boolean(lead) };
}
