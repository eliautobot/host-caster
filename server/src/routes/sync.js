// GET/PUT /api/sync: one JSON doc per user with a revision. PUT with a stale rev answers 409 with the current rev.
// Plain API keys never get stored in the doc: any that slip through move to secrets and become secretRefs.
// What the hosts remember about the listener (doc.memories) is sealed at rest like the secrets (AES-256-GCM, bound
// to the user) and opened again for this user's GET; a doc from an older app without memories keeps the stored ones.
// The listener's list (doc.tracker: what to do, what they wait for, from their mail and calendar) is sealed the same
// way (doc.trackerSealed), and an older app's push without it keeps the stored list too.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { putSecret } from './secrets.js';
import { withoutBuiltinBrain } from './syncDoc.js';
import { syncItemRoutes } from './syncItems.js';

const ARRAYS = ['hosts', 'stations', 'brains', 'voices', 'playlists', 'memories', 'tracker'];
/** the collections an older app may leave out (its push keeps the stored ones) */
const OPTIONAL = new Set(['memories', 'tracker']);
/** a curated memory is ~60 cards of up to 200 characters; this only stops abuse */
const MAX_MEMORIES = 200;
const MAX_MEMORY_TEXT = 400;
/** the list keeps open items plus a few weeks of done ones; these only stop abuse */
const MAX_TRACKED = 1500;
const MAX_TRACKED_BYTES = 4000;
/** sealed collections: doc[name] is stored as doc[`${name}Sealed`], bound to the user (aad `<user>:sync:<name>`) */
const SEALED = ['memories', 'tracker'];
const sealedAad = (userId, name) => `${userId}:sync:${name}`;

/** The stored doc with its memories opened (they are sealed at rest). */
export function readDoc(app, userId) {
  const row = app.db.prepare('SELECT json, rev, updated_at FROM sync_docs WHERE user_id = ?').get(userId);
  if (!row) return { rev: 0, doc: null, updatedAt: 0 };
  return { rev: row.rev, doc: openSealed(app, userId, JSON.parse(row.json)), updatedAt: row.updated_at };
}

function openSealed(app, userId, doc) {
  if (!doc || typeof doc !== 'object') return doc;
  for (const name of SEALED) {
    const sealed = doc[`${name}Sealed`];
    delete doc[`${name}Sealed`];
    try {
      doc[name] = sealed ? JSON.parse(app.sealer.open(sealed, sealedAad(userId, name))) : Array.isArray(doc[name]) ? doc[name] : [];
    } catch {
      doc[name] = [];
    }
  }
  return doc;
}

/** Seals doc.memories and doc.tracker for storage (an empty list stores nothing). */
function sealCollections(app, userId, doc) {
  for (const name of SEALED) {
    const list = doc[name] ?? [];
    delete doc[name];
    delete doc[`${name}Sealed`];
    if (list.length) doc[`${name}Sealed`] = app.sealer.seal(JSON.stringify(list), sealedAad(userId, name));
  }
  return doc;
}

function validate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'invalid_doc', 'doc must be an object');
  for (const key of ARRAYS) {
    // an older app sends no memories (or list): the stored ones stay (filled in by the caller)
    if (doc[key] === undefined && OPTIONAL.has(key)) continue;
    if (doc[key] === undefined) doc[key] = [];
    if (!Array.isArray(doc[key])) throw new HttpError(400, 'invalid_doc', `doc.${key} must be an array`);
    for (const item of doc[key]) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
        throw new HttpError(400, 'invalid_doc', `doc.${key} items need a string id`);
      }
    }
  }
  if (doc.memories) {
    if (doc.memories.length > MAX_MEMORIES) throw new HttpError(400, 'invalid_doc', `doc.memories holds at most ${MAX_MEMORIES} cards`);
    for (const m of doc.memories) {
      if (typeof m.text !== 'string' || m.text.length > MAX_MEMORY_TEXT) throw new HttpError(400, 'invalid_doc', `doc.memories cards need a text of at most ${MAX_MEMORY_TEXT} characters`);
    }
  }
  if (doc.tracker) {
    if (doc.tracker.length > MAX_TRACKED) throw new HttpError(400, 'invalid_doc', `doc.tracker holds at most ${MAX_TRACKED} items`);
    for (const item of doc.tracker) {
      if (typeof item.what !== 'string' || item.what.length > 400 || JSON.stringify(item).length > MAX_TRACKED_BYTES) {
        throw new HttpError(400, 'invalid_doc', 'doc.tracker items need a short `what`');
      }
    }
  }
  // a client never plants a sealed blob
  for (const name of SEALED) delete doc[`${name}Sealed`];
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
    for (const name of SEALED) if (doc[name] === undefined) doc[name] = current.doc?.[name] ?? [];
    sealCollections(app, user.id, doc);
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
