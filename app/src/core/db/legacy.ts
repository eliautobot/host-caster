// One-time move from the app's old name (Airwave, before the Host-Caster rename) so existing devices keep their songs,
// hosts and settings: the old IndexedDB database is copied into the new one, the app's own records that carry the
// old name are renamed, then the old database is deleted. Runs in initDb before seeding; a no-op once the old
// database is gone. (The theme key in localStorage moves in index.html, before first paint.)
import Dexie from 'dexie';
import type { Brain, Break, Host, Station, VoiceProvider } from '../types';
import { HostCasterDB } from './schema';

export const LEGACY_DB_NAME = 'airwave';
const LEGACY_KIND = 'airwave';
const LEGACY_WORD = /\bAirwave\b/g;
const NEW_WORD = 'Host-Caster';
/** kv marker: the copy finished (only the delete of the old database is left). */
export const LEGACY_DONE_KEY = 'migration:legacy-db';
const TABLES = ['tracks', 'blobs', 'playlists', 'hosts', 'stations', 'brains', 'voices', 'breaks', 'profile', 'settings', 'kv'] as const;
/** Rows per copy step: blobs are whole songs, so keep memory low on phones. */
const CHUNK = 20;

const word = (text: string | undefined): string | undefined => text?.replace(LEGACY_WORD, NEW_WORD);
const kind = <T extends string>(value: T | undefined): T | undefined => ((value as string) === LEGACY_KIND ? ('hostcaster' as T) : value);

/** The record with the old name replaced in the app's own names and ids; the same object when nothing changed. */
export function renameLegacyRecord(table: string, rec: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  let next: Record<string, unknown> = rec;
  if (table === 'brains') {
    const b = rec as unknown as Brain;
    const included = (b.kind as string) === LEGACY_KIND;
    next = { ...b, kind: kind(b.kind), preset: kind(b.preset), model: included ? kind(b.model) : b.model, name: word(b.name) };
  } else if (table === 'voices') {
    const v = rec as unknown as VoiceProvider & { preset?: string };
    next = { ...v, kind: kind(v.kind), preset: kind(v.preset), name: word(v.name) };
  } else if (table === 'stations') {
    const s = rec as unknown as Station;
    next = { ...s, name: word(s.name), description: word(s.description) };
  } else if (table === 'hosts') {
    const h = rec as unknown as Host;
    next = {
      ...h,
      tagline: word(h.tagline),
      personality: word(h.personality),
      style: word(h.style),
      catchphrases: h.catchphrases?.map((c) => word(c) ?? c),
    };
  } else if (table === 'breaks') {
    const b = rec as unknown as Break;
    next = { ...b, lines: b.lines?.map((l) => ({ ...l, text: word(l.text) ?? l.text })) };
  }
  if (next === rec) return rec;
  for (const k of Object.keys(next)) if (next[k] === undefined && !(k in rec)) delete next[k];
  if (JSON.stringify(next) === JSON.stringify(rec)) return rec;
  // records sync by updatedAt, so the renamed copy wins over the old one on the server
  return { ...next, updatedAt: Math.max(now, Number(rec.updatedAt) || 0) };
}

/** Copies the old database into `db` (once), renames the old name in it, deletes the old database. */
export async function migrateLegacyDb(db: HostCasterDB, legacyName = LEGACY_DB_NAME, now = Date.now()): Promise<boolean> {
  if (!(await Dexie.exists(legacyName))) return false;
  if (!(await db.kv.get(LEGACY_DONE_KEY))) {
    const old = new HostCasterDB(legacyName);
    try {
      await old.open();
      for (const name of TABLES) {
        const keys = await old.table(name).toCollection().primaryKeys();
        for (let i = 0; i < keys.length; i += CHUNK) {
          const rows = (await old.table(name).bulkGet(keys.slice(i, i + CHUNK))).filter(Boolean) as Record<string, unknown>[];
          await db.table(name).bulkPut(rows.map((r) => renameLegacyRecord(name, r, now)));
        }
      }
    } finally {
      old.close();
    }
    await db.kv.put({ id: LEGACY_DONE_KEY, value: true, fetchedAt: now, createdAt: now, updatedAt: now });
  }
  await Dexie.delete(legacyName);
  return true;
}
