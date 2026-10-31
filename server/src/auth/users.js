// Users and their sign-in identities.
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser(db, { name = '', email = null, avatarUrl = null, passwordHash = null }) {
  const id = randomUUID();
  const t = now();
  db.prepare(
    'INSERT INTO users (id, name, email, avatar_url, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, email, avatarUrl, passwordHash, t, t);
  return getUser(db, id);
}

export function updateUser(db, id, patch) {
  const cols = { name: 'name', email: 'email', avatarUrl: 'avatar_url', passwordHash: 'password_hash' };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getUser(db, id);
  db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
  return getUser(db, id);
}

export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

export function deleteUser(db, id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function listIdentities(db, userId) {
  return db.prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at').all(userId);
}

export function findIdentity(db, provider, subject) {
  return db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?').get(provider, String(subject));
}

export function getIdentity(db, userId, provider) {
  return db.prepare('SELECT * FROM identities WHERE user_id = ? AND provider = ?').get(userId, provider);
}

/** Inserts or updates the identity row (tokens sealed by the caller). */
export function upsertIdentity(db, { userId, provider, subject, scopes, tokensEnc, profile }) {
  const t = now();
  const existing = findIdentity(db, provider, subject);
  const data = JSON.stringify(profile ?? {});
  if (existing) {
    db.prepare(
      'UPDATE identities SET user_id = ?, scopes = ?, tokens_enc = COALESCE(?, tokens_enc), profile = ?, updated_at = ? WHERE id = ?',
    ).run(userId, scopes, tokensEnc ?? null, data, t, existing.id);
    return findIdentity(db, provider, subject);
  }
  db.prepare(
    'INSERT INTO identities (id, user_id, provider, subject, scopes, tokens_enc, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), userId, provider, String(subject), scopes, tokensEnc ?? null, data, t, t);
  return findIdentity(db, provider, subject);
}

export function deleteIdentity(db, userId, provider) {
  return db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').run(userId, provider).changes;
}

/** Public shape (ApiUser in app/src/core/types.ts) plus linked accounts. */
export function toApiUser(db, user) {
  const identities = listIdentities(db, user.id);
  const providers = identities.map((i) => i.provider);
  if (user.password_hash) providers.push('local');
  return {
    id: user.id,
    name: user.name,
    email: user.email ?? undefined,
    avatarUrl: user.avatar_url ?? undefined,
    providers,
    identities: identities.map((i) => {
      const profile = safeJson(i.profile);
      return {
        provider: i.provider,
        label: profile.email ?? (profile.username ? `@${profile.username}` : profile.name) ?? '',
        scopes: i.scopes ? i.scopes.split(' ').filter(Boolean) : [],
        linkedAt: i.created_at,
      };
    }),
    hasPassword: Boolean(user.password_hash),
    emailVerified: Boolean(user.email_verified_at),
    createdAt: user.created_at,
  };
}

export function safeJson(text, fallback = {}) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
