// Short-lived one-time records: OAuth state (+PKCE verifier), native exchange codes, link tickets.
import { createHash, randomBytes } from 'node:crypto';
import { randomToken, sha256 } from '../crypto.js';

export const FLOW_TTL = { oauth: 10 * 60 * 1000, exchange: 2 * 60 * 1000, link: 5 * 60 * 1000, linkfinish: 2 * 60 * 1000, chatgpt: 10 * 60 * 1000, notionstart: 5 * 60 * 1000, notionfinish: 2 * 60 * 1000 };

/** Stores a flow and returns the raw token (state / code / ticket). */
export function putFlow(db, kind, { provider = null, userId = null, data = {} } = {}) {
  const raw = randomToken(32);
  const t = Date.now();
  db.prepare('DELETE FROM auth_flows WHERE expires_at < ?').run(t);
  db.prepare(
    'INSERT INTO auth_flows (id, kind, provider, user_id, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(raw), kind, provider, userId, JSON.stringify(data), t, t + FLOW_TTL[kind]);
  return raw;
}

/** Reads and deletes (one-time). Undefined when missing, expired or of another kind. */
export function takeFlow(db, kind, raw) {
  if (!raw || typeof raw !== 'string') return undefined;
  const id = sha256(raw);
  const row = db.prepare('SELECT * FROM auth_flows WHERE id = ?').get(id);
  if (!row) return undefined;
  db.prepare('DELETE FROM auth_flows WHERE id = ?').run(id);
  if (row.kind !== kind || row.expires_at < Date.now()) return undefined;
  return { provider: row.provider, userId: row.user_id, data: JSON.parse(row.data) };
}

export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
