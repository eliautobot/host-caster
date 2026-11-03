// A device joining an account (its first sync, no base) must never replace most of the account. Mirrors the app's
// joinOverwrites (app/src/core/api/merge.ts): counted in parts, each host and station of the account (a starter never
// saved does not count), its profile (when not blank), its settings and each deletion still in force; a part changes
// when the pushed doc differs from it (a deletion dropped counts).

const TOMBSTONE_TTL = 90 * 24 * 3600_000;
const PROFILE_FIELDS = ['name', 'callMe', 'about', 'location', 'units', 'lifeEvents', 'notes', 'reminders', 'interests', 'avoidTopics'];
const SETTINGS_FIELDS = ['theme', 'activeStationId'];

/** Sorted-key JSON, undefined left out (equal data, equal text). */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}

const content = (rec) => {
  const { createdAt: _c, updatedAt: _u, ...rest } = rec ?? {};
  return stable(rest);
};
const same = (a, b) => stable(a ?? null) === stable(b ?? null);
const seededUnsaved = (r) => String(r.id).startsWith('seed-') && (r.updatedAt ?? 0) <= (r.createdAt ?? 0) + 1000;
const blankProfile = (p) =>
  !p || (!p.name && !p.about && !p.callMe && !p.lifeEvents?.length && !p.notes?.length && !p.reminders?.length && !p.interests?.length);

export function joinOverwrites(account, pushed, now = Date.now()) {
  let changed = 0;
  let parts = 0;
  const count = (differs) => {
    parts++;
    if (differs) changed++;
  };
  for (const c of ['hosts', 'stations']) {
    const next = new Map((pushed[c] ?? []).map((r) => [r.id, r]));
    for (const rec of account[c] ?? []) {
      if (seededUnsaved(rec)) continue;
      const t = next.get(rec.id);
      count(!t || content(t) !== content(rec));
    }
  }
  if (!blankProfile(account.profile)) count(PROFILE_FIELDS.some((k) => !same(account.profile[k], pushed.profile?.[k])));
  if (account.settings) {
    const s = account.settings;
    const t = pushed.settings ?? {};
    const conn = s.connections ?? {};
    const tconn = t.connections ?? {};
    count(SETTINGS_FIELDS.some((k) => s[k] !== undefined && !same(s[k], t[k])) || Object.keys(conn).some((k) => !same(conn[k], tconn[k])));
  }
  for (const [key, at] of Object.entries(account.deleted ?? {})) {
    if (at > now - TOMBSTONE_TTL) count(!(pushed.deleted && key in pushed.deleted));
  }
  return { changed, parts };
}

/** A join that would change most of an account (at least 3 parts). */
export function isDestructiveJoin(account, pushed, now = Date.now()) {
  const { changed, parts } = joinOverwrites(account, pushed, now);
  return changed >= 3 && changed * 2 > parts;
}
