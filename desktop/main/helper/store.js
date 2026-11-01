// The ChatGPT sign-in on this PC: the same records as the server's chatgpt_accounts table (server/src/chatgpt/store.js),
// kept for the one person using this app in a JSON file in the app's data folder. The token set is sealed with the
// OS keychain (Electron safeStorage: Keychain on macOS, DPAPI on Windows, the Secret Service on Linux) before it is
// written, so the file never holds a usable token. Nothing here is sent to the Host-Caster server.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {string} file
 * @param {{ seal: (text: string) => string, open: (sealed: string) => string }} keychain
 */
export function createFileStore(file, keychain) {
  let data = load();

  function load() {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return { accounts: Array.isArray(j?.accounts) ? j.accounts : [], state: j?.state && typeof j.state === 'object' ? j.state : {} };
    } catch {
      return { accounts: [], state: {} };
    }
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  }

  const copy = (row) => (row ? { ...row } : undefined);
  const mine = (userId) => data.accounts.filter((r) => r.user_id === userId);
  const find = (id) => data.accounts.find((r) => r.id === id);

  return {
    get: (id) => copy(find(id)),
    active: (userId) => copy(mine(userId).find((r) => r.active === 1)),
    /** the registration to reuse for the next sign-in: the active one, else the last one that signed in */
    saved(userId) {
      const rows = mine(userId).sort(
        (a, b) => (b.active ?? 0) - (a.active ?? 0) || Number(b.subject != null) - Number(a.subject != null) || b.updated_at - a.updated_at,
      );
      return copy(rows[0]);
    },
    byClient: (userId, clientId) => copy(mine(userId).find((r) => r.client_id === clientId)),
    all: (userId) => mine(userId).map(copy),

    /** A new issued client id: kept right away so a failed code exchange does not register another app. */
    register(userId, clientId) {
      const existing = mine(userId).find((r) => r.client_id === clientId);
      if (existing) return copy(existing);
      const t = Date.now();
      const row = {
        id: randomUUID(),
        user_id: userId,
        client_id: clientId,
        status: 'pending',
        subject: null,
        email: null,
        name: null,
        scopes: null,
        active: 0,
        paused_until: null,
        last_error: null,
        tokens_enc: null,
        created_at: t,
        updated_at: t,
      };
      data.accounts.push(row);
      save();
      return copy(row);
    },

    tokens(row) {
      if (!row?.tokens_enc) return undefined;
      try {
        const box = JSON.parse(keychain.open(row.tokens_enc));
        // bound to its record: a sealed set copied onto another record does not open
        return box?.row === row.id ? box.tokens : undefined;
      } catch {
        return undefined;
      }
    },

    /** Saves the whole token set (access, expiry, scopes, rotating refresh token) together with the patch. */
    update(row, patch, tokens) {
      const r = find(row.id);
      if (!r) return undefined;
      Object.assign(r, patch, { updated_at: Date.now() });
      if (tokens !== undefined) r.tokens_enc = tokens === null ? null : keychain.seal(JSON.stringify({ row: r.id, tokens }));
      save();
      return copy(r);
    },

    deactivateOthers: (userId, keepId) => mine(userId).filter((r) => r.id !== keepId && r.active === 1).map(copy),

    getState: (userId, key) => data.state[`${userId}:${key}`],
    setState(userId, key, value) {
      data.state[`${userId}:${key}`] = value;
      save();
    },

    /** Forgets every record (Desktop settings, Forget ChatGPT sign-in, after the tokens were revoked). */
    clear() {
      data = { accounts: [], state: {} };
      save();
    },
  };
}
