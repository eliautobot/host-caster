// GET/PUT /api/sync: one JSON doc per user with a revision. PUT with a stale rev answers 409 with the current rev.
// Plain API keys never get stored in the doc: any that slip through move to secrets and become secretRefs.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { putSecret } from './secrets.js';
import { withoutBuiltinBrain } from './syncDoc.js';
import { syncItemRoutes } from './syncItems.js';

const ARRAYS = ['hosts', 'stations', 'brains', 'voices', 'playlists'];

export function readDoc(app, userId) {
  const row = app.db.prepare('SELECT json, rev, updated_at FROM sync_docs WHERE user_id = ?').get(userId);
  if (!row) return { rev: 0, doc: null, updatedAt: 0 };
  return { rev: row.rev, doc: JSON.parse(row.json), updatedAt: row.updated_at };
}

function validate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'invalid_doc', 'doc must be an object');
  for (const key of ARRAYS) {
    if (doc[key] === undefined) doc[key] = [];
    if (!Array.isArray(doc[key])) throw new HttpError(400, 'invalid_doc', `doc.${key} must be an array`);
    for (const item of doc[key]) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
        throw new HttpError(400, 'invalid_doc', `doc.${key} items need a string id`);
      }
    }
  }
  if (doc.deleted !== undefined && (typeof doc.deleted !== 'object' || Array.isArray(doc.deleted))) {
    throw new HttpError(400, 'invalid_doc', 'doc.deleted must be an object');
  }
  return doc;
}

/** Moves any apiKey in brains/voices into the user's secrets. */
function sealKeys(app, userId, doc) {
  for (const [key, prefix] of [
    ['brains', 'brain'],
    ['voices', 'voice'],
  ]) {
    doc[key] = doc[key].map((item) => {
      if (!item.apiKey) return item;
      const { apiKey, ...rest } = item;
      const ref = rest.secretRef || `${prefix}:${item.id}`;
      putSecret(app, userId, ref, apiKey);
      return { ...rest, secretRef: ref };
    });
  }
  return doc;
}

export async function syncRoutes(app) {
  // songs, playlist lists and unplayable marks: their own records (GET/POST /api/sync/items)
  await syncItemRoutes(app);

  app.get('/api/sync', async (req) => {
    const user = requireUser(req);
    const { rev, doc, updatedAt } = readDoc(app, user.id);
    return { rev, doc, updatedAt };
  });

  app.put('/api/sync', async (req, reply) => {
    const user = requireUser(req);
    const baseRev = Number(req.body?.rev ?? -1);
    // an older app may still send hosts on the built-in brain: store them with none (the scripted fallback covers them)
    const doc = withoutBuiltinBrain(sealKeys(app, user.id, validate(structuredClone(req.body?.doc))));
    const current = readDoc(app, user.id);
    if (baseRev !== current.rev) {
      return reply.status(409).send({ error: { code: 'conflict', message: 'The doc changed on another device' }, rev: current.rev });
    }
    const rev = current.rev + 1;
    const t = Date.now();
    const res = app.db
      .prepare(
        `INSERT INTO sync_docs (user_id, json, rev, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at
         WHERE sync_docs.rev = ?`,
      )
      .run(user.id, JSON.stringify(doc), rev, t, current.rev);
    if (res.changes === 0) {
      return reply.status(409).send({ error: { code: 'conflict', message: 'The doc changed on another device' }, rev: readDoc(app, user.id).rev });
    }
    return { rev, updatedAt: t };
  });
}
