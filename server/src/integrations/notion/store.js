// Notion link (sealed tokens, workspace, the listener's choices) and the activity log of what the hosts added.
import { randomUUID } from 'node:crypto';

const aad = (userId) => `notion:${userId}`;

/** Settings with every field present: what the hosts may read and where (and whether) they write. */
export function normalSettings(raw = {}) {
  const read = Array.isArray(raw.read) ? raw.read.filter((r) => r && typeof r.id === 'string').slice(0, 5) : [];
  return {
    read: read.map((r) => ({ id: r.id, type: r.type === 'data_source' ? 'data_source' : 'page', title: String(r.title ?? '').slice(0, 200) })),
    write: raw.write && typeof raw.write.id === 'string' ? raw.write : null,
    writesOn: raw.writesOn !== false,
    recapOn: raw.recapOn === true,
    recapDay: typeof raw.recapDay === 'string' ? raw.recapDay : undefined,
  };
}

export function getLink(app, userId) {
  const row = app.db.prepare('SELECT * FROM notion_links WHERE user_id = ?').get(userId);
  if (!row) return undefined;
  let tokens;
  try {
    tokens = JSON.parse(app.sealer.open(row.tokens_enc, aad(userId)));
  } catch {
    tokens = undefined;
  }
  let settings;
  try {
    settings = normalSettings(JSON.parse(row.settings || '{}'));
  } catch {
    settings = normalSettings();
  }
  return {
    botId: row.bot_id,
    workspace: { id: row.workspace_id, name: row.workspace_name, icon: row.workspace_icon },
    tokens,
    settings,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stores a new consent. Reconnecting the same workspace keeps the listener's choices (a page they no longer share is
 * reported when it is read); another workspace starts over.
 */
export function saveLink(app, userId, { botId, workspace, tokens }) {
  const prev = getLink(app, userId);
  const sameWorkspace = prev && prev.workspace.id && prev.workspace.id === workspace.id;
  const settings = sameWorkspace ? prev.settings : normalSettings();
  const t = Date.now();
  app.db
    .prepare(
      `INSERT INTO notion_links (user_id, bot_id, workspace_id, workspace_name, workspace_icon, tokens_enc, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET bot_id = excluded.bot_id, workspace_id = excluded.workspace_id,
         workspace_name = excluded.workspace_name, workspace_icon = excluded.workspace_icon, tokens_enc = excluded.tokens_enc,
         settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .run(userId, botId, workspace.id, workspace.name, workspace.icon, app.sealer.seal(JSON.stringify(tokens), aad(userId)), JSON.stringify(settings), t, t);
  return getLink(app, userId);
}

export function saveTokens(app, userId, tokens) {
  app.db
    .prepare('UPDATE notion_links SET tokens_enc = ?, updated_at = ? WHERE user_id = ?')
    .run(app.sealer.seal(JSON.stringify(tokens), aad(userId)), Date.now(), userId);
}

export function saveSettings(app, userId, settings) {
  const next = normalSettings(settings);
  app.db.prepare('UPDATE notion_links SET settings = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(next), Date.now(), userId);
  return next;
}

/** Disconnect: the link and the activity log go (what the hosts wrote stays in the listener's Notion). */
export function deleteLink(app, userId) {
  app.db.prepare('DELETE FROM notion_links WHERE user_id = ?').run(userId);
  app.db.prepare('DELETE FROM notion_activity WHERE user_id = ?').run(userId);
}

const ACTIVITY_KEEP = 200;

export function addActivity(app, userId, a) {
  const id = randomUUID();
  app.db
    .prepare(
      `INSERT INTO notion_activity (id, user_id, at, source, kind, text, page_id, page_title, block_id, status, error, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, Date.now(), a.source, a.kind, a.text, a.pageId ?? null, a.pageTitle ?? null, a.blockId ?? null, a.status, a.error ?? null, a.ref ?? null);
  // keep the newest 200 per account
  app.db
    .prepare(
      `DELETE FROM notion_activity WHERE user_id = ? AND id NOT IN
         (SELECT id FROM notion_activity WHERE user_id = ? ORDER BY at DESC LIMIT ${ACTIVITY_KEEP})`,
    )
    .run(userId, userId);
  return getActivity(app, userId, id);
}

const view = (r) => ({
  id: r.id,
  at: r.at,
  source: r.source,
  kind: r.kind,
  text: r.text,
  pageId: r.page_id ?? undefined,
  pageTitle: r.page_title ?? undefined,
  status: r.status,
  error: r.error ?? undefined,
  undoneAt: r.undone_at ?? undefined,
  canUndo: r.status === 'done' && Boolean(r.block_id),
});

export function getActivity(app, userId, id) {
  const r = app.db.prepare('SELECT * FROM notion_activity WHERE user_id = ? AND id = ?').get(userId, id);
  return r ? { ...view(r), blockId: r.block_id ?? undefined } : undefined;
}

/** The answer already given to an ask (an inbox item two devices both picked up, a retried request). */
export function activityByRef(app, userId, ref) {
  const r = app.db.prepare('SELECT * FROM notion_activity WHERE user_id = ? AND ref = ?').get(userId, ref);
  return r ? view(r) : undefined;
}

export function listActivity(app, userId, limit = 50) {
  return app.db.prepare('SELECT * FROM notion_activity WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(userId, limit).map(view);
}

export function markUndone(app, userId, id) {
  app.db.prepare("UPDATE notion_activity SET status = 'undone', undone_at = ? WHERE user_id = ? AND id = ?").run(Date.now(), userId, id);
  return view(app.db.prepare('SELECT * FROM notion_activity WHERE user_id = ? AND id = ?').get(userId, id));
}

/** Writes in the last `windowMs` (a per-account cap so a loop can never fill someone's Notion). */
export function writesSince(app, userId, windowMs) {
  return app.db.prepare("SELECT COUNT(*) AS n FROM notion_activity WHERE user_id = ? AND at > ? AND source != 'recap' AND status = 'done'").get(userId, Date.now() - windowMs).n;
}
