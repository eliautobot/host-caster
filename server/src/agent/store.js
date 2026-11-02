// The hosts' lookups per account (table agent_lookups, migration 9): the log the listener sees and the daily caps.
const DAY = 86_400_000;
const KEEP_MS = 30 * DAY;

/** Start of "today" for the caps: a rolling 24 hours (no time zone guesswork, same for every device). */
const since = (now) => now - DAY;

export function logLookup(app, userId, { tool, what, host, purpose, ok = true, ms, costUsd = 0, where = 'server', at = Date.now() }) {
  app.db
    .prepare('INSERT INTO agent_lookups (user_id, at, tool, what, host, purpose, ok, ms, cost_micros, where_ran) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      userId,
      at,
      String(tool).slice(0, 40),
      String(what ?? '').slice(0, 300),
      host ? String(host).slice(0, 80) : null,
      purpose ? String(purpose).slice(0, 120) : null,
      ok ? 1 : 0,
      Number.isFinite(ms) ? Math.round(ms) : null,
      Math.round((Number(costUsd) || 0) * 1e6),
      where === 'device' ? 'device' : 'server',
    );
  // keep 30 days (cheap: the index is by user and time)
  if (Math.random() < 0.02) app.db.prepare('DELETE FROM agent_lookups WHERE at < ?').run(Date.now() - KEEP_MS);
}

export function usedToday(app, userId, now = Date.now()) {
  const row = app.db
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN tool = 'web_search' AND ok = 1 THEN 1 ELSE 0 END) AS web FROM agent_lookups WHERE user_id = ? AND at >= ?")
    .get(userId, since(now));
  return { lookups: Number(row?.n ?? 0), webSearches: Number(row?.web ?? 0) };
}

export function listLookups(app, userId, limit = 100) {
  return app.db
    .prepare('SELECT id, at, tool, what, host, purpose, ok, ms, where_ran FROM agent_lookups WHERE user_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(userId, Date.now() - KEEP_MS, Math.max(1, Math.min(500, limit)))
    .map((r) => ({
      id: r.id,
      at: r.at,
      tool: r.tool,
      what: r.what,
      ...(r.host ? { host: r.host } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ok: r.ok === 1,
      ...(r.ms !== null ? { ms: r.ms } : {}),
      where: r.where_ran,
    }));
}

export function clearLookups(app, userId) {
  return app.db.prepare('DELETE FROM agent_lookups WHERE user_id = ?').run(userId).changes;
}
