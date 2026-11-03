// The listener's choice per tool: allowed without asking (auto), ask first (ask) or off. Kept in
// settings.connections.agent.policy (synced with the rest of Settings). Sensible defaults: look-ups and changes to
// Host-Caster's own data run, changes in other accounts ask first, and what other people see never runs unasked.
import type { Connections } from '../../types';
import type { AgentTool, Policy } from './types';

/** The choices Settings offers for a tool. */
export function choices(tool: Pick<AgentTool, 'kind' | 'level' | 'policies'>): Policy[] {
  if (tool.policies) return tool.policies;
  if (tool.kind !== 'outside-write') return ['auto', 'off'];
  return tool.level === 3 ? ['ask', 'off'] : ['auto', 'ask', 'off'];
}

export function defaultPolicy(tool: Pick<AgentTool, 'kind' | 'level' | 'policies' | 'defaultPolicy'>): Policy {
  const allowed = choices(tool);
  if (tool.defaultPolicy && (allowed.includes(tool.defaultPolicy) || !allowed.length)) return tool.defaultPolicy;
  const d: Policy = tool.kind === 'outside-write' ? 'ask' : 'auto';
  return allowed.length && !allowed.includes(d) ? allowed[0]! : d;
}

/** The policy in force: the listener's choice when it is one of the tool's choices, else the default. */
export function policyOf(tool: Pick<AgentTool, 'name' | 'kind' | 'level' | 'policies' | 'defaultPolicy'>, connections: Connections): Policy {
  const chosen = connections.agent?.policy?.[tool.name];
  return chosen && choices(tool).includes(chosen) ? chosen : defaultPolicy(tool);
}

/** Settings > Connections with one tool's policy changed (a choice the tool does not offer is refused). */
export function withPolicy(connections: Connections, tool: Pick<AgentTool, 'name' | 'kind' | 'level' | 'policies' | 'defaultPolicy'>, p: Policy): Connections {
  if (!choices(tool).includes(p)) return connections;
  const policy = { ...(connections.agent?.policy ?? {}) };
  if (p === defaultPolicy(tool)) delete policy[tool.name];
  else policy[tool.name] = p;
  return { ...connections, agent: { ...connections.agent, policy } };
}

export const POLICY_WORDS: Record<Policy, string> = { auto: 'Without asking', ask: 'Ask me first', off: 'Off' };
