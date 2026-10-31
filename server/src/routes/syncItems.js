// GET/POST /api/sync/items: synced songs, playlist lists and unplayable marks, one record each, next to the small sync
// doc (a liked list can be thousands of songs; the doc would resend all of them on every edit). Pulls are incremental
// by the account's change counter (seq), paged; pushes are per record: the newer updatedAt wins ('track',
// 'unplayable'), or compare-and-set on `base` ('members': a device merges a list it edited with the other device's
// edits instead of overwriting them). An older app only knows PUT /api/sync and never touches these rows.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';

export const ITEM_KINDS = ['track', 'members', 'unplayable'];
export const MAX_PUSH = 500;
const MAX_PULL = 2000;
const DEFAULT_PULL = 1000;
const MAX_ID = 512;
const MAX_BYTES = { track: 16 * 1024, unplayable: 2 * 1024, members: 1024 * 1024 };
/** a device clock running ahead may not win every later edit for long */
const FUTURE_SLACK = 5 * 60_000;
export const TOMBSTONE_TTL = 180 * 24 * 3600_000;
const PRUNE_EVERY = 24 * 3600_000;

function readMeta(app, userId) {
  return app.db.prepare('SELECT seq, pruned_seq, pruned_at FROM sync_item_meta WHERE user_id = ?').get(userId) ?? { seq: 0, pruned_seq: 0, pruned_at: 0 };
}

const toItem = (r) => ({ kind: r.kind, id: r.id, updatedAt: r.updated_at, ...(r.json === null ? { deleted: true } : { data: JSON.parse(r.json) }) });

/** Changes after `since` in seq order. A cursor older than dropped tombstones (or newer than this server) starts over. */
export function pullItems(app, userId, since, limit = DEFAULT_PULL) {
  const meta = readMeta(app, userId);
  const reset = since > 0 && (since > meta.seq || since < meta.pruned_seq);
  const from = reset ? 0 : since;
  const rows = app.db
    .prepare('SELECT kind, id, json, updated_at, seq FROM sync_items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(userId, from, limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map(toItem),
    // the whole rest was sent: everything up to the account's seq is seen (also changes whose rows were dropped)
    cursor: more ? page.at(-1).seq : Math.max(from, meta.seq),
    more,
    ...(reset ? { reset: true } : {}),
  };
}

function validItems(body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.length > MAX_PUSH) throw new HttpError(400, 'invalid_items', `items must be an array of at most ${MAX_PUSH}`);
  return items.map((it, i) => {
    const bad = (why) => new HttpError(400, 'invalid_items', `items[${i}]: ${why}`);
    if (!it || typeof it !== 'object') throw bad('must be an object');
    if (!ITEM_KINDS.includes(it.kind)) throw bad(`kind must be one of ${ITEM_KINDS.join(', ')}`);
    if (typeof it.id !== 'string' || !it.id || it.id.length > MAX_ID) throw bad(`id must be a string of 1..${MAX_ID}`);
    if (!Number.isFinite(it.updatedAt) || it.updatedAt <= 0) throw bad('updatedAt must be a positive number (ms)');
    if (it.base !== undefined && (!Number.isFinite(it.base) || it.base < 0)) throw bad('base must be a number');
    let json = null;
    if (!it.deleted) {
      if (!it.data || typeof it.data !== 'object' || Array.isArray(it.data)) throw bad('data must be an object (or deleted: true)');
      json = JSON.stringify(it.data);
      if (Buffer.byteLength(json) > MAX_BYTES[it.kind]) throw new HttpError(413, 'item_too_large', `items[${i}] is larger than ${MAX_BYTES[it.kind]} bytes`);
    }
    return { kind: it.kind, id: it.id, updatedAt: Math.round(it.updatedAt), base: it.base, json };
  });
}

/** Drops tombstones older than TOMBSTONE_TTL (once a day per account); cursors from before them start over. */
function pruneTombstones(app, userId, meta, now) {
  if (now - meta.pruned_at < PRUNE_EVERY) return meta;
  const cutoff = now - TOMBSTONE_TTL;
  const top = app.db.prepare('SELECT MAX(seq) AS s FROM sync_items WHERE user_id = ? AND json IS NULL AND updated_at < ?').get(userId, cutoff)?.s;
  if (top) app.db.prepare('DELETE FROM sync_items WHERE user_id = ? AND json IS NULL AND updated_at < ?').run(userId, cutoff);
  return { ...meta, pruned_seq: Math.max(meta.pruned_seq, top ?? 0), pruned_at: now };
}

/**
 * Applies a batch in one transaction. Returns `before`/`cursor` (the account's seq before and after: a device whose
 * cursor was `before` can move to `cursor` without pulling its own records back), records the server kept instead
 * (`stale`, with the server's version) and `refused` (new records the account's limit had no room for; `full` = count).
 */
export function pushItems(app, userId, items, now = Date.now()) {
  const db = app.db;
  const get = db.prepare('SELECT json, updated_at FROM sync_items WHERE user_id = ? AND kind = ? AND id = ?');
  const put = db.prepare(
    `INSERT INTO sync_items (user_id, kind, id, json, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, seq = excluded.seq`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    let meta = readMeta(app, userId);
    const before = meta.seq;
    let seq = meta.seq;
    let live = db.prepare('SELECT COUNT(*) AS n FROM sync_items WHERE user_id = ? AND json IS NOT NULL').get(userId).n;
    const stale = [];
    let accepted = 0;
    const refused = [];
    for (const it of items) {
      const cur = get.get(userId, it.kind, it.id);
      const at = Math.min(it.updatedAt, now + FUTURE_SLACK);
      if (cur && cur.json === it.json && (cur.updated_at === at || it.json === null)) {
        accepted++; // already there (a deletion stays the first one)
        continue;
      }
      const wins = !cur || (it.base !== undefined ? cur.updated_at === it.base : at > cur.updated_at);
      if (!wins) {
        stale.push(toItem({ kind: it.kind, id: it.id, json: cur.json, updated_at: cur.updated_at }));
        continue;
      }
      const adds = it.json !== null && (!cur || cur.json === null);
      if (adds && live >= app.config.syncMaxItems) {
        refused.push({ kind: it.kind, id: it.id });
        continue;
      }
      if (adds) live++;
      else if (it.json === null && cur?.json != null) live--;
      put.run(userId, it.kind, it.id, it.json, at, ++seq);
      accepted++;
    }
    meta = pruneTombstones(app, userId, { ...meta, seq }, now);
    db.prepare(
      `INSERT INTO sync_item_meta (user_id, seq, pruned_seq, pruned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET seq = excluded.seq, pruned_seq = excluded.pruned_seq, pruned_at = excluded.pruned_at`,
    ).run(userId, seq, meta.pruned_seq, meta.pruned_at);
    db.exec('COMMIT');
    return { before, cursor: seq, accepted, stale, ...(refused.length ? { full: refused.length, refused } : {}) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const intIn = (v, lo, hi, dflt) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
};

export async function syncItemRoutes(app) {
  app.get('/api/sync/items', async (req) => {
    const user = requireUser(req);
    return pullItems(app, user.id, intIn(req.query?.since, 0, Number.MAX_SAFE_INTEGER, 0), intIn(req.query?.limit, 1, MAX_PULL, DEFAULT_PULL));
  });

  app.post('/api/sync/items', async (req) => {
    const user = requireUser(req);
    const items = validItems(req.body);
    const res = pushItems(app, user.id, items);
    return { ...res, max: app.config.syncMaxItems };
  });
}
