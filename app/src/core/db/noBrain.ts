// "Built-in host" used to be a brain you could pick. It is now only the scripted fallback, so hosts that saved it (or
// a stored brain of that kind) move to "no AI brain" (null) once: on this device and in synced docs from the server.
import { LEGACY_BUILTIN_BRAIN_ID, type Brain, type Host, type SyncDoc } from '../types';
import type { HostCasterDB } from './schema';

export const NO_BRAIN_DONE_KEY = 'migrate:no-builtin-brain';

const isLegacyBrain = (b: Pick<Brain, 'id' | 'kind'>) => b.kind === 'builtin' || b.id === LEGACY_BUILTIN_BRAIN_ID;

/** The host with null instead of the legacy built-in brain (or a brain in `gone`); the same object when nothing changes. */
export function withoutLegacyBrain<H extends Pick<Host, 'brainId'>>(host: H, gone: ReadonlySet<string> = new Set()): H {
  const id = host.brainId;
  if (id === null) return host;
  if (id && id !== LEGACY_BUILTIN_BRAIN_ID && !gone.has(id)) return host;
  return { ...host, brainId: null };
}

/** A synced doc without built-in brains: hosts on one get null, the brain records are dropped. Same doc when clean. */
export function migrateDocBrains(doc: SyncDoc): SyncDoc {
  const brains = Array.isArray(doc.brains) ? doc.brains : [];
  const gone = new Set(brains.filter(isLegacyBrain).map((b) => b.id));
  const hosts = Array.isArray(doc.hosts) ? doc.hosts : [];
  const nextHosts = hosts.map((h) => withoutLegacyBrain(h, gone));
  if (!gone.size && nextHosts.every((h, i) => h === hosts[i])) return doc;
  return { ...doc, hosts: nextHosts, brains: brains.filter((b) => !gone.has(b.id)) };
}

/**
 * One-time move on this device (again with `force`, after restoring a backup); returns how many hosts changed.
 * updatedAt is kept: this is not an edit.
 */
export async function migrateLocalBrains(db: HostCasterDB, now = Date.now(), opts: { force?: boolean } = {}): Promise<number> {
  if (!opts.force && (await db.kv.get(NO_BRAIN_DONE_KEY))) return 0;
  return db.transaction('rw', [db.hosts, db.brains, db.kv], async () => {
    const legacy = (await db.brains.toArray()).filter(isLegacyBrain).map((b) => b.id);
    const gone = new Set(legacy);
    let changed = 0;
    await db.hosts.toCollection().modify((h: Host) => {
      const next = withoutLegacyBrain(h, gone);
      if (next === h) return;
      h.brainId = null;
      changed++;
    });
    if (legacy.length) await db.brains.bulkDelete(legacy);
    await db.kv.put({ id: NO_BRAIN_DONE_KEY, value: { hosts: changed, brains: legacy.length }, fetchedAt: now, createdAt: now, updatedAt: now });
    return changed;
  });
}
