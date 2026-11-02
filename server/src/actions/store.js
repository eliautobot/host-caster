// The actions log (table actions, migration 10): every proposal and what became of it. The state moves only through
// the functions here, each one a compare-and-set inside a db transaction, so two devices (or twenty requests) racing
// on the same action see exactly one winner. Payload, words and result are sealed per row (aad action:<user>:<id>);
// the confirmation token is kept as its sha256 only.
import { randomUUID } from 'node:crypto';
import { randomToken, safeEqual, sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';

const DAY = 86_400_000;
const KEEP_MS = 90 * DAY;
export const UNDO_WINDOW_MS = 7 * DAY;
/** an execution that never finished (the server restarted mid-way) is reported as unknown after this long */
export const STALE_EXECUTING_MS = 5 * 60_000;
/** a second undo may start when the first one has not finished after this long */
const UNDO_RETRY_MS = 60_000;

const aad = (userId, id) => `action:${userId}:${id}`;

/** Runs fn (synchronous) in one IMMEDIATE transaction. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function openEnc(app, row) {
  try {
    return JSON.parse(app.sealer.open(row.enc, aad(row.user_id, row.id)));
  } catch {
    return { payload: {}, summary: '' };
  }
}

const sealEnc = (app, userId, id, enc) => app.sealer.seal(JSON.stringify(enc), aad(userId, id));

/** The action as the app gets it. */
export function toAction(app, row, now = Date.now()) {
  const enc = openEnc(app, row);
  const undoable = row.status === 'done' && row.undoable === 1 && now - (row.executed_at ?? 0) < UNDO_WINDOW_MS;
  return {
    id: row.id,
    type: row.type,
    level: row.level,
    origin: row.origin,
    status: row.status,
    summary: enc.summary,
    ...(enc.others ? { others: enc.others } : {}),
    payload: enc.payload,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at, confirmedVia: row.confirmed_via } : {}),
    ...(row.executed_at ? { executedAt: row.executed_at } : {}),
    ...(enc.result ? { result: enc.result } : {}),
    ...(row.error_code ? { error: { code: row.error_code, message: row.error_message ?? '' } } : {}),
    undoable,
    ...(row.undone_at ? { undoneAt: row.undone_at } : {}),
  };
}

/** The sealed extras (said, context, undo) for the executor. */
export const secretsOf = (app, row) => openEnc(app, row);

/** An error whose answer also carries the current action ({ error, action }). */
export function withAction(err, app, row) {
  err.action = toAction(app, row);
  return err;
}

const rowOf = (app, userId, id) => app.db.prepare('SELECT * FROM actions WHERE id = ? AND user_id = ?').get(id, userId);

/**
 * Lazy clock moves: a proposal past its time is expired; an execution stuck for minutes (a restart) is failed with
 * an honest "cannot tell".
 */
function settle(app, row, now) {
  if (!row) return row;
  if (row.status === 'proposed' && row.expires_at <= now) {
    app.db.prepare("UPDATE actions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'proposed'").run(now, row.id);
    return rowOf(app, row.user_id, row.id);
  }
  if (row.status === 'executing' && (row.token_used_at ?? 0) < now - STALE_EXECUTING_MS) {
    app.db
      .prepare("UPDATE actions SET status = 'failed', error_code = 'unknown_outcome', error_message = ?, updated_at = ? WHERE id = ? AND status = 'executing'")
      .run('Host-Caster stopped before Google answered, so it cannot tell whether this went through. Check Google before asking again.', now, row.id);
    return rowOf(app, row.user_id, row.id);
  }
  return row;
}

export function getRow(app, userId, id, now = Date.now()) {
  return settle(app, rowOf(app, userId, id), now);
}

export function rowByRef(app, userId, ref, now = Date.now()) {
  return settle(app, app.db.prepare('SELECT * FROM actions WHERE user_id = ? AND ref = ?').get(userId, ref), now);
}

export function listRows(app, userId, { limit = 50, status } = {}, now = Date.now()) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = status
    ? app.db.prepare('SELECT * FROM actions WHERE user_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, status, n)
    : app.db.prepare('SELECT * FROM actions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, n);
  const settled = rows.map((r) => settle(app, r, now));
  return status ? settled.filter((r) => r.status === status) : settled;
}

/** Counts for the daily caps (a rolling 24 hours): proposals made, executions started. */
export function usedToday(app, userId, now = Date.now()) {
  const since = now - DAY;
  const proposals = app.db.prepare('SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND created_at >= ?').get(userId, since).n;
  const actions = app.db.prepare('SELECT COUNT(*) AS n FROM actions WHERE user_id = ? AND token_used_at >= ?').get(userId, since).n;
  return { actions: Number(actions), proposals: Number(proposals) };
}

let lastPrune = 0;
/** Rows older than 90 days go (at most once an hour). */
export function prune(app, now = Date.now()) {
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  app.db.prepare('DELETE FROM actions WHERE created_at < ?').run(now - KEEP_MS);
}

/** A new proposal. With a `ref` already used, the existing one comes back instead ({ existing: true }). */
export function insertProposal(app, userId, { type, level, origin, ref, payload, payloadHash, summary, others, said, context, ttlMs, perDay }, now = Date.now()) {
  return tx(app.db, () => {
    if (ref) {
      const old = app.db.prepare('SELECT * FROM actions WHERE user_id = ? AND ref = ?').get(userId, ref);
      if (old) return { row: old, existing: true };
    }
    if (usedToday(app, userId, now).proposals >= perDay) {
      throw new HttpError(429, 'proposals_limit', `Your hosts suggested ${perDay} things today, the most for one day. Try again tomorrow.`);
    }
    const id = randomUUID();
    const enc = sealEnc(app, userId, id, { payload, summary, ...(others ? { others } : {}), ...(said ? { said } : {}), context: context ?? {} });
    app.db
      .prepare(
        `INSERT INTO actions (id, user_id, type, level, origin, status, enc, payload_hash, ref, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, type, level, origin, enc, payloadHash, ref ?? null, now, now + ttlMs, now);
    return { row: rowOf(app, userId, id), existing: false };
  });
}

const notFound = () => new HttpError(404, 'not_found', 'No such action');

/**
 * Confirms a proposal bound to `payloadHash`: issues a one-time token (only its sha256 is kept). When someone already
 * confirmed it (another device) or it ran, the action comes back without a token. A confirmation whose token ran out
 * unused may be renewed.
 */
export function confirmRow(app, userId, id, { payloadHash, via, tokenTtlMs, perDay }, now = Date.now()) {
  return tx(app.db, () => {
    const row = settle(app, rowOf(app, userId, id), now);
    if (!row) throw notFound();
    if (typeof payloadHash !== 'string' || !safeEqual(payloadHash, row.payload_hash)) {
      throw withAction(new HttpError(409, 'payload_changed', 'This is not what was asked. Nothing happened.'), app, row);
    }
    if (row.status === 'expired') throw withAction(new HttpError(410, 'action_expired', 'That waited too long, so nothing happened. Ask again.'), app, row);
    if (row.status === 'cancelled') throw withAction(new HttpError(410, 'action_expired', 'That was cancelled, so nothing happened. Ask again.'), app, row);
    const renew = row.status === 'confirmed' && !row.token_used_at && (row.token_expires_at ?? 0) <= now;
    if (row.status !== 'proposed' && !renew) return { row };
    if (usedToday(app, userId, now).actions >= perDay) {
      throw withAction(new HttpError(429, 'actions_limit', `Your hosts did ${perDay} things for you today, the most for one day. Try again tomorrow.`), app, row);
    }
    const token = randomToken(32);
    const res = app.db
      .prepare(
        `UPDATE actions SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), confirmed_via = COALESCE(confirmed_via, ?),
           token_hash = ?, token_expires_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND token_used_at IS NULL AND (status = 'proposed' OR (status = 'confirmed' AND token_expires_at <= ?))`,
      )
      .run(now, via, sha256(token), now + tokenTtlMs, now, id, userId, now);
    if (res.changes !== 1) return { row: rowOf(app, userId, id) };
    return { row: rowOf(app, userId, id), token };
  });
}

/**
 * Spends the token and moves confirmed -> executing in one transaction. `hash` is the sha256 of the canonical
 * { type, payload } the caller sent (null when it did not even parse).
 */
export function claimExecution(app, userId, id, { token, hash, perDay }, now = Date.now()) {
  return tx(app.db, () => {
    const row = settle(app, rowOf(app, userId, id), now);
    if (!row) throw notFound();
    const fail = (status, code, message) => withAction(new HttpError(status, code, message), app, row);
    if (typeof token !== 'string' || !token || !row.token_hash || !safeEqual(sha256(token), row.token_hash)) {
      throw fail(401, 'token_invalid', 'That confirmation is not valid. Nothing happened.');
    }
    if (row.token_used_at) throw fail(401, 'token_used', 'That confirmation was already used.');
    if (row.status !== 'confirmed') throw fail(401, 'token_invalid', 'That confirmation is not valid anymore. Nothing happened.');
    if ((row.token_expires_at ?? 0) <= now) throw fail(401, 'token_expired', 'That confirmation waited too long, so nothing happened. Confirm again.');
    if (!hash || !safeEqual(hash, row.payload_hash)) throw fail(409, 'payload_changed', 'This is not what was confirmed. Nothing happened.');
    if (usedToday(app, userId, now).actions >= perDay) {
      throw fail(429, 'actions_limit', `Your hosts did ${perDay} things for you today, the most for one day. Try again tomorrow.`);
    }
    const res = app.db
      .prepare("UPDATE actions SET status = 'executing', token_used_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'confirmed' AND token_used_at IS NULL")
      .run(now, now, id, userId);
    if (res.changes !== 1) throw fail(401, 'token_used', 'That confirmation was already used.');
    return rowOf(app, userId, id);
  });
}

/** executing -> done (with the result and what undo needs) | failed (with a plain error). */
export function finishExecution(app, row, outcome, now = Date.now()) {
  return tx(app.db, () => {
    const current = rowOf(app, row.user_id, row.id);
    if (!current || current.status !== 'executing') return current;
    const enc = openEnc(app, current);
    if (outcome.ok) {
      const next = sealEnc(app, row.user_id, row.id, { ...enc, result: outcome.result, undo: outcome.undo });
      app.db
        .prepare("UPDATE actions SET status = 'done', enc = ?, executed_at = ?, attempts = ?, undoable = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'executing'")
        .run(next, now, outcome.attempts ?? 1, outcome.undo ? 1 : 0, now, row.id);
    } else {
      app.db
        .prepare("UPDATE actions SET status = 'failed', attempts = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'executing'")
        .run(outcome.attempts ?? 1, outcome.code, outcome.message, now, row.id);
    }
    return rowOf(app, row.user_id, row.id);
  });
}

/** proposed | confirmed (token unused) -> cancelled. Anything else stays as it is. */
export function cancelRow(app, userId, id, now = Date.now()) {
  return tx(app.db, () => {
    const row = settle(app, rowOf(app, userId, id), now);
    if (!row) throw notFound();
    app.db
      .prepare("UPDATE actions SET status = 'cancelled', token_hash = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND (status = 'proposed' OR (status = 'confirmed' AND token_used_at IS NULL))")
      .run(now, id, userId);
    return rowOf(app, userId, id);
  });
}

/** Claims the undo of a done action ({ row, claimed }): only one undo runs at a time. */
export function claimUndo(app, userId, id, now = Date.now()) {
  return tx(app.db, () => {
    const row = settle(app, rowOf(app, userId, id), now);
    if (!row) throw notFound();
    if (row.status === 'undone') return { row, claimed: false };
    if (row.status !== 'done' || row.undoable !== 1) {
      throw withAction(new HttpError(409, 'not_undoable', 'There is nothing to undo here.'), app, row);
    }
    if (now - (row.executed_at ?? 0) >= UNDO_WINDOW_MS) {
      throw withAction(new HttpError(409, 'not_undoable', 'That was more than 7 days ago, so it can only be changed in Google now.'), app, row);
    }
    const res = app.db
      .prepare("UPDATE actions SET undo_started_at = ?, updated_at = ? WHERE id = ? AND status = 'done' AND (undo_started_at IS NULL OR undo_started_at < ?)")
      .run(now, now, id, now - UNDO_RETRY_MS);
    return { row: rowOf(app, userId, id), claimed: res.changes === 1 };
  });
}

/** done -> undone, or (undo failed) done with the error and the undo free to try again. */
export function finishUndo(app, row, outcome, now = Date.now()) {
  return tx(app.db, () => {
    if (outcome.ok) {
      app.db
        .prepare("UPDATE actions SET status = 'undone', undone_at = ?, undo_started_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'done'")
        .run(now, now, row.id);
    } else {
      app.db
        .prepare("UPDATE actions SET undo_started_at = NULL, error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'done'")
        .run(outcome.code, outcome.message, now, row.id);
    }
    return rowOf(app, row.user_id, row.id);
  });
}
