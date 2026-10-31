// Per-user secrets (provider API keys, IMAP password) sealed with AES-256-GCM. Values never go back to a client (a
// stolen session or an injected script must not walk away with the user's provider keys): the server uses them for
// the calls it proxies, and clients only see a short hint.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';

const REF = /^[A-Za-z0-9:_.-]{1,100}$/;

export function checkRef(ref) {
  if (!REF.test(String(ref ?? ''))) throw new HttpError(400, 'invalid_ref', 'Secret refs use letters, digits and : _ . -');
  return String(ref);
}

export function putSecret(app, userId, ref, value) {
  const t = Date.now();
  const sealed = app.sealer.seal(String(value), `${userId}:${ref}`);
  app.db
    .prepare(
      `INSERT INTO secrets (user_id, ref, value_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, ref) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    )
    .run(userId, ref, sealed, t, t);
}

export function getSecret(app, userId, ref) {
  if (!ref) return undefined;
  const row = app.db.prepare('SELECT value_enc FROM secrets WHERE user_id = ? AND ref = ?').get(userId, ref);
  if (!row) return undefined;
  try {
    return app.sealer.open(row.value_enc, `${userId}:${ref}`);
  } catch {
    return undefined;
  }
}

export function deleteSecret(app, userId, ref) {
  return app.db.prepare('DELETE FROM secrets WHERE user_id = ? AND ref = ?').run(userId, ref).changes;
}

const hint = (value) => (value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 3)}…${value.slice(-4)}`);

export async function secretsRoutes(app) {
  app.get('/api/secrets', async (req) => {
    const user = requireUser(req);
    const rows = app.db.prepare('SELECT ref, updated_at FROM secrets WHERE user_id = ? ORDER BY ref').all(user.id);
    return {
      secrets: rows.map((r) => {
        const value = getSecret(app, user.id, r.ref) ?? '';
        return { ref: r.ref, hint: r.ref.startsWith('imap') ? '' : hint(value), updatedAt: r.updated_at };
      }),
    };
  });

  app.get('/api/secrets/:ref', async (req) => {
    const user = requireUser(req);
    const ref = checkRef(req.params.ref);
    const row = app.db.prepare('SELECT updated_at FROM secrets WHERE user_id = ? AND ref = ?').get(user.id, ref);
    const value = row && getSecret(app, user.id, ref);
    if (value === undefined || ref.startsWith('imap')) throw new HttpError(404, 'not_found', 'No such secret');
    return { ref, hint: hint(value), updatedAt: row.updated_at };
  });

  app.put('/api/secrets/:ref', async (req) => {
    const user = requireUser(req);
    const ref = checkRef(req.params.ref);
    const value = req.body?.value;
    if (typeof value !== 'string' || !value || value.length > 8192) {
      throw new HttpError(400, 'invalid_request', 'value must be a non-empty string');
    }
    putSecret(app, user.id, ref, value);
    return { ref };
  });

  app.delete('/api/secrets/:ref', async (req, reply) => {
    const user = requireUser(req);
    deleteSecret(app, user.id, checkRef(req.params.ref));
    return reply.status(204).send();
  });
}
