// MCP over Streamable HTTP at POST /mcp/:token (JSON responses, no SSE stream). The token in the URL identifies the
// user and the AI app connection; tokens are made in Settings -> Connections -> AI apps.
import { rateLimiter } from '../auth/password.js';
import { sha256 } from '../crypto.js';
import { TOOLS, ToolInputError } from './tools.js';

/** JSON-RPC batch size (one rate-limit hit each, so a batch must not multiply what one request can do) */
export const MAX_BATCH = 20;
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED[0];

const INSTRUCTIONS =
  "Host-Caster is the listener's personal AI radio station. Use these tools to see what is playing and to pass notes, " +
  'segments, song requests and dates to the radio hosts. The hosts mention them in the next break between songs.';

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function handle(ctx, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // a response or garbage: responses from the client are acknowledged with nothing
    if (msg && (msg.result !== undefined || msg.error !== undefined)) return undefined;
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return undefined;
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hostcaster', title: 'Host-Caster radio', version: ctx.app.config.version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
      try {
        return rpcResult(id, tool.run(ctx, args));
      } catch (err) {
        if (err instanceof ToolInputError) return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        ctx.app.log.error(err, 'mcp tool failed');
        return rpcResult(id, { content: [{ type: 'text', text: 'Host-Caster could not do that right now.' }], isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcpRoutes(app) {
  const limiter = rateLimiter(120, 60 * 1000);

  const connector = (token) => {
    if (!/^aw_[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ''))) return undefined;
    return app.db.prepare('SELECT * FROM connector_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token));
  };

  app.post('/mcp/:token', async (req, reply) => {
    const row = connector(req.params.token);
    if (!row) return reply.status(404).send(rpcError(null, -32001, 'Unknown or revoked Host-Caster connection URL'));
    if (!limiter.hit(row.id)) return reply.status(429).send(rpcError(null, -32002, 'Too many requests; slow down'));
    app.db.prepare('UPDATE connector_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
    const ctx = { app, db: app.db, userId: row.user_id, source: row.name };
    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      return reply.status(400).send(rpcError(null, -32700, 'Parse error'));
    }
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) return reply.status(400).send(rpcError(null, -32600, `Up to ${MAX_BATCH} messages per batch`));
      const out = body.map((m) => handle(ctx, m)).filter(Boolean);
      return out.length ? reply.type('application/json').send(out) : reply.status(202).send();
    }
    const out = handle(ctx, body);
    if (!out) return reply.status(202).send();
    return reply.type('application/json').send(out);
  });

  // No server-initiated stream and no sessions to end.
  for (const method of ['GET', 'DELETE']) {
    app.route({
      method,
      url: '/mcp/:token',
      handler: async (_req, reply) => reply.status(405).header('allow', 'POST').send(rpcError(null, -32000, 'Use POST')),
    });
  }
}
