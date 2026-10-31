// Inbox: notes, segments, song requests and life events that AI apps push over MCP. The client polls GET /api/inbox,
// uses items in the next break and marks one-shot items consumed. Also POST /api/now-playing for the MCP tool.
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';

export const INBOX_KINDS = ['note', 'segment', 'song_request', 'life_event'];
const NOTE_TTL = 24 * 60 * 60 * 1000;

export function addInboxItem(db, userId, { kind, payload, source = null, until = null }) {
  if (!INBOX_KINDS.includes(kind)) throw new Error(`bad inbox kind ${kind}`);
  const id = randomUUID();
  const t = Date.now();
  const expires = until ?? (kind === 'note' ? t + NOTE_TTL : null);
  db.prepare('INSERT INTO inbox (id, user_id, kind, payload, source, until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    kind,
    JSON.stringify(payload),
    source,
    expires,
    t,
  );
  // keep the inbox small: drop old consumed / expired rows
  db.prepare('DELETE FROM inbox WHERE user_id = ? AND ((consumed_at IS NOT NULL AND consumed_at < ?) OR (until IS NOT NULL AND until < ?))').run(
    userId,
    t - 7 * NOTE_TTL,
    t - NOTE_TTL,
  );
  return id;
}

export function pendingInbox(db, userId) {
  const t = Date.now();
  return db
    .prepare('SELECT * FROM inbox WHERE user_id = ? AND consumed_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at LIMIT 100')
    .all(userId, t)
    .map((r) => {
      const p = JSON.parse(r.payload);
      return {
        id: r.id,
        kind: r.kind,
        text: p.text ?? p.query ?? p.title ?? '',
        ...(p.hostName ? { hostName: p.hostName } : {}),
        ...(p.date ? { date: p.date, yearly: Boolean(p.yearly) } : {}),
        ...(r.until ? { until: r.until } : {}),
        ...(r.source ? { source: r.source } : {}),
        createdAt: r.created_at,
      };
    });
}

export function getUserState(db, userId, key) {
  const row = db.prepare('SELECT json, updated_at FROM user_state WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? { value: JSON.parse(row.json), updatedAt: row.updated_at } : undefined;
}

function setUserState(db, userId, key, value) {
  db.prepare(
    `INSERT INTO user_state (user_id, key, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), Date.now());
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

const hasConnector = (db, userId) =>
  Boolean(db.prepare('SELECT 1 FROM connector_tokens WHERE user_id = ? AND revoked_at IS NULL LIMIT 1').get(userId));

/** Forgets what was on air (no AI app connection left to ask for it). */
export function forgetNowPlaying(db, userId) {
  db.prepare("DELETE FROM user_state WHERE user_id = ? AND key = 'now_playing'").run(userId);
}

export async function inboxRoutes(app) {
  app.get('/api/inbox', async (req) => ({ items: pendingInbox(app.db, requireUser(req).id) }));

  app.post('/api/inbox/consume', async (req) => {
    const user = requireUser(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
    const stmt = app.db.prepare('UPDATE inbox SET consumed_at = ? WHERE user_id = ? AND id = ? AND consumed_at IS NULL');
    let n = 0;
    for (const id of ids) n += stmt.run(Date.now(), user.id, id).changes;
    return { consumed: n };
  });

  app.delete('/api/inbox/:id', async (req, reply) => {
    const user = requireUser(req);
    app.db.prepare('DELETE FROM inbox WHERE user_id = ? AND id = ?').run(user.id, req.params.id);
    return reply.status(204).send();
  });

  // The client reports what is on air so AI apps can ask (MCP now_playing). Kept only while the account has an AI app
  // connection: otherwise the server holds nothing about the songs someone plays.
  app.post('/api/now-playing', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    if (!hasConnector(app.db, user.id)) {
      forgetNowPlaying(app.db, user.id);
      return { ok: true, stored: false };
    }
    if (b.playing === false) {
      setUserState(app.db, user.id, 'now_playing', { playing: false });
      return { ok: true };
    }
    const track = b.track && typeof b.track === 'object' ? b.track : undefined;
    if (!track) throw new HttpError(400, 'invalid_request', 'track is required');
    setUserState(app.db, user.id, 'now_playing', {
      playing: true,
      station: str(b.station, 120),
      track: { title: str(track.title, 300) ?? '', artist: str(track.artist, 300) ?? '', album: str(track.album, 300) },
      hosts: Array.isArray(b.hosts) ? b.hosts.map((h) => str(h, 80)).filter(Boolean).slice(0, 4) : [],
      onAir: Boolean(b.onAir),
      speaking: str(b.speaking, 80),
    });
    return { ok: true };
  });
}
