// What a turn knows about this account right now: read fresh every turn (the server's view at most 30 s old in a
// listener turn), so a service connected or a switch turned on during a call is in the next turn's tools.
import { actionsStatus } from '../../actions/engine';
import { api } from '../../api/client';
import { getSettings } from '../../db';
import type { Connections } from '../../types';
import { serverStatus, type ToolContext } from '../tools';
import { isListenerTurn, type AgentEnv, type MusicHooks, type TurnKind } from './types';

const LISTENER_MAX_AGE_MS = 30_000;

export interface EnvInput {
  turn: TurnKind;
  ctx: ToolContext;
  hasBrain: boolean;
  music?: MusicHooks;
  connections?: Connections;
}

export async function loadEnv(input: EnvInput): Promise<AgentEnv> {
  const connections = input.connections ?? (await getSettings()).connections;
  const signedIn = api.available && api.signedIn;
  const listener = isListenerTurn(input.turn);
  const [server, google] = signedIn
    ? await Promise.all([
        serverStatus(false, listener ? LISTENER_MAX_AGE_MS : undefined).catch(() => undefined),
        actionsStatus(false).catch(() => undefined),
      ])
    : [undefined, undefined];
  return {
    turn: input.turn,
    online: api.available,
    signedIn: Boolean(api.session),
    connections,
    server: server?.tools,
    google,
    hasBrain: input.hasBrain,
    music: input.music,
    ctx: input.ctx,
  };
}
