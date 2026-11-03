// The built-in tool source: look-ups, Host-Caster's own data, other accounts and the approvals. Registered once
// at import; an MCP source or a plug-in calls registerSource the same way.
import { approveTool, cancelTool } from '../approval';
import { registerSource } from '../registry';
import type { ToolSource } from '../types';
import { appTools } from './app';
import { lookupTools } from './lookups';
import { outsideTools } from './outside';

export const builtinSource: ToolSource = {
  id: 'builtin',
  tools: () => [...lookupTools(), ...appTools(), ...outsideTools(), approveTool, cancelTool],
};

registerSource(builtinSource);
