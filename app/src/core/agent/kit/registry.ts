// One tool registry, rebuilt every turn (docs/AGENT.md, section 1). Sources add tools; buildToolbox asks each tool
// whether it can run for this account right now and applies the listener's policy and the turn's rules. Connect or
// disconnect a service and its tools appear or vanish on the next turn. An MCP source or a plug-in registers the
// same way and gets the same checks: there is no special case for built-in tools here.
import type { ToolSpec } from '../../types';
import { choices, policyOf, POLICY_WORDS } from './policy';
import { isListenerTurn, type AgentEnv, type AgentTool, type Availability, type OfferedTool, type OffTool, type ToolSource, type Toolbox } from './types';

const sources = new Map<string, ToolSource>();

export function registerSource(source: ToolSource): void {
  sources.set(source.id, source);
}

export function unregisterSource(id: string): void {
  sources.delete(id);
}

export function sourceIds(): string[] {
  return [...sources.keys()];
}

/** Settings path words for a tool the listener switched off here. */
const policyFix = (tool: AgentTool) =>
  `Settings, Connections, What your hosts can do: set "${tool.title}" to ${choices(tool)
    .filter((p) => p !== 'off')
    .map((p) => `"${POLICY_WORDS[p]}"`)
    .join(' or ')}`;

/** The tool's own answer; a check that throws counts as not working right now. */
export async function availability(tool: AgentTool, env: AgentEnv): Promise<Availability> {
  try {
    return await tool.available(env);
  } catch {
    return { ok: false, reason: 'unavailable', fix: 'It is not working right now' };
  }
}

/** Whether this kind of turn may even have the tool (writes never in the background; approvals only when the listener talks). */
export function allowedInTurn(tool: Pick<AgentTool, 'kind' | 'firstStepOnly'>, turn: AgentEnv['turn']): boolean {
  if (tool.firstStepOnly) return isListenerTurn(turn);
  if (tool.kind === 'read') return true;
  return turn !== 'background';
}

/** Every source's tools this kind of turn may have (unique, valid names), with their source. */
export async function allTools(env: AgentEnv): Promise<{ tool: AgentTool; source: string }[]> {
  const out: { tool: AgentTool; source: string }[] = [];
  const seen = new Set<string>();
  for (const source of sources.values()) {
    let tools: AgentTool[];
    try {
      tools = await source.tools(env);
    } catch {
      continue;
    }
    for (const tool of tools) {
      if (seen.has(tool.name) || !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name) || !allowedInTurn(tool, env.turn)) continue;
      seen.add(tool.name);
      out.push({ tool, source: source.id });
    }
  }
  return out;
}

/** Every source's tools for this turn: offered (with their policy) or off (with the reason and the fix). */
export async function buildToolbox(env: AgentEnv): Promise<Toolbox> {
  const offered: OfferedTool[] = [];
  const offList: OffTool[] = [];
  // a broken source (an MCP server that went away) takes only its own tools with it (allTools skips it)
  for (const { tool, source } of await allTools(env)) {
    const policy = policyOf(tool, env.connections);
    if (policy === 'off') {
      offList.push({ tool, source, reason: 'switched-off', fix: policyFix(tool) });
      continue;
    }
    const a = await availability(tool, env);
    if (a.ok) offered.push({ tool, source, policy });
    else offList.push({ tool, source, reason: a.reason, fix: a.fix });
  }
  const byName = new Map(offered.map((o) => [o.tool.name, o]));
  return {
    env,
    offered,
    off: offList,
    get: (name) => byName.get(name),
    specs: (): ToolSpec[] => offered.map(({ tool }) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  };
}
