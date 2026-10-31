// "Built-in host" used to be a brain a host could have. It is only the scripted fallback now: in a synced doc, hosts on
// it (or on a stored brain of kind 'builtin') get brainId null and those brain records go. Pure; same doc when clean.
const LEGACY_ID = 'builtin';

export function withoutBuiltinBrain(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const brains = Array.isArray(doc.brains) ? doc.brains : [];
  const hosts = Array.isArray(doc.hosts) ? doc.hosts : [];
  const gone = new Set(brains.filter((b) => b && (b.kind === 'builtin' || b.id === LEGACY_ID)).map((b) => b.id));
  let changed = gone.size > 0;
  const nextHosts = hosts.map((h) => {
    if (!h || typeof h !== 'object' || h.brainId === null) return h;
    if (typeof h.brainId === 'string' && h.brainId && h.brainId !== LEGACY_ID && !gone.has(h.brainId)) return h;
    changed = true;
    return { ...h, brainId: null };
  });
  if (!changed) return doc;
  return { ...doc, hosts: nextHosts, brains: brains.filter((b) => !gone.has(b?.id)) };
}

/** One-time pass over every stored doc (db migration 5): a changed doc gets a new rev so devices pull it. */
export function migrateBuiltinBrains(db, now = Date.now()) {
  const rows = db.prepare(`SELECT user_id, json, rev FROM sync_docs WHERE json LIKE '%builtin%'`).all();
  const update = db.prepare('UPDATE sync_docs SET json = ?, rev = ?, updated_at = ? WHERE user_id = ?');
  let changed = 0;
  for (const row of rows) {
    let doc;
    try {
      doc = JSON.parse(row.json);
    } catch {
      continue;
    }
    const next = withoutBuiltinBrain(doc);
    if (next === doc) continue;
    update.run(JSON.stringify(next), row.rev + 1, now, row.user_id);
    changed++;
  }
  return changed;
}
