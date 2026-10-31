// AI app connector tokens (Settings -> Connections -> AI apps). The MCP URL is /mcp/<token>; the token is stored
// hashed for lookup and sealed so the owner can copy the URL again later.
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth/session.js';
import { randomToken, sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';
import { forgetNowPlaying } from './inbox.js';

const MAX_PER_USER = 20;

export const mcpUrl = (config, token) => `${config.publicUrl}/mcp/${token}`;

function view(app, row) {
  let url;
  try {
    url = row.token_enc ? mcpUrl(app.config, app.sealer.open(row.token_enc, `connector:${row.id}`)) : undefined;
  } catch {
    url = undefined;
  }
  return { id: row.id, name: row.name, url, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined };
}

export async function connectorRoutes(app) {
  app.get('/api/connectors', async (req) => {
    const user = requireUser(req);
    const rows = app.db
      .prepare('SELECT * FROM connector_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at')
      .all(user.id);
    return { connectors: rows.map((r) => view(app, r)) };
  });

  app.post('/api/connectors', async (req, reply) => {
    const user = requireUser(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'AI app';
    const count = app.db.prepare('SELECT COUNT(*) AS n FROM connector_tokens WHERE user_id = ? AND revoked_at IS NULL').get(user.id).n;
    if (count >= MAX_PER_USER) throw new HttpError(409, 'too_many', `Up to ${MAX_PER_USER} AI app connections`);
    const id = randomUUID();
    const token = `aw_${randomToken(24)}`;
    app.db
      .prepare('INSERT INTO connector_tokens (id, user_id, token_hash, token_enc, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, user.id, sha256(token), app.sealer.seal(token, `connector:${id}`), name, Date.now());
    const row = app.db.prepare('SELECT * FROM connector_tokens WHERE id = ?').get(id);
    return reply.status(201).send(view(app, row));
  });

  app.patch('/api/connectors/:id', async (req) => {
    const user = requireUser(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'invalid_request', 'name is required');
    const res = app.db.prepare('UPDATE connector_tokens SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(name, req.params.id, user.id);
    if (!res.changes) throw new HttpError(404, 'not_found', 'No such connection');
    return view(app, app.db.prepare('SELECT * FROM connector_tokens WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/connectors/:id', async (req, reply) => {
    const user = requireUser(req);
    app.db.prepare('DELETE FROM connector_tokens WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    const left = app.db.prepare('SELECT COUNT(*) AS n FROM connector_tokens WHERE user_id = ? AND revoked_at IS NULL').get(user.id).n;
    if (!left) forgetNowPlaying(app.db, user.id);
    return reply.status(204).send();
  });
}
