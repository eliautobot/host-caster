// chatgpt_accounts rows and their sealed token sets. Tokens are AES-256-GCM sealed with SECRET_KEY, bound to the
// user and row (aad), and never leave the server.
import { randomUUID } from 'node:crypto';

const aad = (row) => `chatgpt:${row.user_id}:${row.id}`;

export function createStore(app) {
  const { db, sealer } = app;
  const get = (id) => db.prepare('SELECT * FROM chatgpt_accounts WHERE id = ?').get(id);

  return {
    get,
    active: (userId) => db.prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ? AND active = 1').get(userId),
    /** the registration to reuse for the next sign-in: the active one, else the last one that signed in */
    saved: (userId) =>
      db
        .prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ? ORDER BY active DESC, (subject IS NOT NULL) DESC, updated_at DESC LIMIT 1')
        .get(userId),
    byClient: (userId, clientId) => db.prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ? AND client_id = ?').get(userId, clientId),
    all: (userId) => db.prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ?').all(userId),

    /** A new issued client id: kept right away so a failed code exchange does not register another app. */
    register(userId, clientId) {
      const t = Date.now();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO chatgpt_accounts (id, user_id, client_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (user_id, client_id) DO NOTHING`,
      ).run(id, userId, clientId, t, t);
      return db.prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ? AND client_id = ?').get(userId, clientId);
    },

    tokens(row) {
      if (!row?.tokens_enc) return undefined;
      try {
        return JSON.parse(sealer.open(row.tokens_enc, aad(row)));
      } catch {
        return undefined;
      }
    },

    /** Saves the whole token set (access, expiry, scopes, rotating refresh token) together with the patch. */
    update(row, patch, tokens) {
      const fields = { ...patch, updated_at: Date.now() };
      if (tokens !== undefined) fields.tokens_enc = tokens === null ? null : sealer.seal(JSON.stringify(tokens), aad(row));
      const keys = Object.keys(fields);
      db.prepare(`UPDATE chatgpt_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), row.id);
      return get(row.id);
    },

    deactivateOthers(userId, keepId) {
      return db.prepare('SELECT * FROM chatgpt_accounts WHERE user_id = ? AND id != ? AND active = 1').all(userId, keepId);
    },

    getState(userId, key) {
      const row = db.prepare('SELECT json FROM user_state WHERE user_id = ? AND key = ?').get(userId, key);
      return row ? JSON.parse(row.json) : undefined;
    },
    setState(userId, key, value) {
      db.prepare(
        `INSERT INTO user_state (user_id, key, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(userId, key, JSON.stringify(value), Date.now());
    },
  };
}
