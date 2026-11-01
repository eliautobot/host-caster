// One-time sign-in records (OAuth state with its sealed PKCE verifier) for the local helper. The server keeps them in
// SQLite (server/src/auth/flows.js); on the PC they live in memory only: a sign-in does not outlive the app.
import { createHash, randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;
const hash = (raw) => createHash('sha256').update(raw).digest('hex');

export function createMemoryFlows(ttlMs = TTL_MS) {
  const flows = new Map();
  const sweep = (now) => {
    for (const [id, f] of flows) if (f.expiresAt < now) flows.delete(id);
  };
  return {
    /** Stores a flow and returns the raw token (the OAuth state). */
    put(kind, { provider = null, userId = null, data = {} } = {}) {
      const raw = randomBytes(32).toString('base64url');
      const now = Date.now();
      sweep(now);
      flows.set(hash(raw), { kind, provider, userId, data: JSON.parse(JSON.stringify(data)), expiresAt: now + ttlMs });
      return raw;
    },
    /** Reads and deletes (one-time). Undefined when missing, expired or of another kind. */
    take(kind, raw) {
      if (!raw || typeof raw !== 'string') return undefined;
      const id = hash(raw);
      const f = flows.get(id);
      if (!f) return undefined;
      flows.delete(id);
      if (f.kind !== kind || f.expiresAt < Date.now()) return undefined;
      return { provider: f.provider, userId: f.userId, data: f.data };
    },
    get size() {
      return flows.size;
    },
  };
}
