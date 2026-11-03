// Backups of everything on this device (owner: server agent, used by Settings -> Data).
// File format: valid JSON, but one record per line so big backups (with songs) import as a stream:
//   {"format":"hostcaster-backup","version":1,...,"records":[
//   {"t":"hosts","r":{...}},
//   {"t":"blob","r":{"id","mime","size","createdAt","updatedAt"},"b64":"..."}
//   ]}
import Dexie, { type Table } from 'dexie';
import { db } from '../db/db';
import { migrateLocalBrains } from '../db/noBrain';
import { DB_NAME } from '../db/schema';
import type { BlobRecord, Brain, VoiceProvider } from '../types';

export const BACKUP_FORMAT = 'hostcaster-backup';
const VERSION = 1;
const TABLES = ['hosts', 'stations', 'brains', 'voices', 'playlists', 'tracks', 'breaks', 'profile', 'settings', 'kv', 'memories', 'journal', 'tracker'] as const;
type TableName = (typeof TABLES)[number];
/**
 * kv rows that belong to this device's session, never to a backup: the session, sync state and which account the data
 * belongs to (restored data is asked about on the next sign-in like any data that never joined the account)
 */
const PRIVATE_KV = /^(api:session|sync:|auth:|account:)/;
/** kv rows that are credentials (music service sign-ins): only in a backup made with keys */
const CREDENTIAL_KV = /^(spotify:(tokens|pending)|subsonic:auth)$/;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  app?: string;
  includes: { songs: boolean; keys: boolean };
  counts: Record<string, number>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) out += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(out);
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Builds the backup as a Blob (parts, so a large library never becomes one giant string).
 * songs = include local audio files; keys = include API keys of brains and voices.
 */
export async function exportBackup(opts: { songs: boolean; keys: boolean; appVersion?: string }): Promise<{ file: Blob; name: string; counts: Record<string, number> }> {
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  for (const t of TABLES) {
    let rows = (await (db[t] as Table).toArray()) as Record<string, unknown>[];
    if (t === 'kv') rows = rows.filter((r) => !PRIVATE_KV.test(String(r.id)) && (opts.keys || !CREDENTIAL_KV.test(String(r.id))));
    if ((t === 'brains' || t === 'voices') && !opts.keys) {
      rows = rows.map((r) => {
        const { apiKey: _k, ...rest } = r as unknown as Brain | VoiceProvider;
        return rest as unknown as Record<string, unknown>;
      });
    }
    if (t === 'settings') rows = rows.map(({ serverUrl: _s, ...rest }) => rest);
    counts[t] = rows.length;
    for (const r of rows) lines.push(JSON.stringify({ t, r }));
  }
  // audio blobs are the local tracks' refs; every other blob (artwork, host photos) always goes along
  const audioIds = new Set((await db.tracks.where('source').equals('local').toArray()).map((tr) => tr.ref));
  const blobIds = (await db.blobs.toCollection().primaryKeys()) as string[];
  let blobCount = 0;
  const blobParts: string[] = [];
  for (const id of blobIds) {
    if (audioIds.has(id) && !opts.songs) continue;
    const rec = (await db.blobs.get(id)) as BlobRecord | undefined;
    if (!rec) continue;
    const { blob, ...meta } = rec;
    blobParts.push(`,\n${JSON.stringify({ t: 'blob', r: meta, b64: await blobToBase64(blob) })}`);
    blobCount++;
  }
  counts.blobs = blobCount;
  const header: BackupFile = {
    format: BACKUP_FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: opts.appVersion,
    includes: { songs: opts.songs, keys: opts.keys },
    counts,
  };
  const headJson = JSON.stringify(header);
  parts.push(`${headJson.slice(0, -1)},"records":[\n`);
  parts.push(lines.join(',\n'));
  if (!lines.length) blobParts[0] = blobParts[0]?.replace(/^,\n/, '') ?? '';
  parts.push(...blobParts, '\n]}\n');
  const day = new Date().toISOString().slice(0, 10);
  return { file: new Blob(parts, { type: 'application/json' }), name: `hostcaster-backup-${day}.json`, counts };
}

/** Streams the file line by line. Calls onRecord for each record line; returns the header. */
async function readBackup(file: Blob, onRecord: (rec: { t: string; r: Record<string, unknown>; b64?: string }) => Promise<void>): Promise<BackupFile> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let header: BackupFile | undefined;
  const handle = async (raw: string) => {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line === ']}' || line === ']') return;
    if (!header) {
      const json = line.endsWith('"records":[') ? `${line.slice(0, -'"records":['.length).replace(/,$/, '')}}` : line;
      const parsed = JSON.parse(json) as BackupFile & { records?: unknown[] };
      if (parsed.format !== BACKUP_FORMAT) throw new Error('This is not a Host-Caster backup file');
      if (parsed.version > VERSION) throw new Error('This backup was made by a newer Host-Caster. Update first.');
      header = parsed;
      // a backup re-saved by another tool as one line of JSON still works
      for (const rec of parsed.records ?? []) await onRecord(rec as never);
      return;
    }
    await onRecord(JSON.parse(line) as never);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      await handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (done) break;
  }
  await handle(buf);
  if (!header) throw new Error('The backup file is empty');
  return header;
}

/**
 * Replaces this device's data with the backup (the server URL stays). Signed-in devices merge it with the account
 * on the next sync, like a first sync.
 */
export async function importBackup(file: Blob): Promise<BackupFile> {
  // validate the header before wiping anything
  const head = await file.slice(0, 4096).text();
  if (!head.includes(`"format":"${BACKUP_FORMAT}"`)) throw new Error('This is not a Host-Caster backup file');
  // a full read first: a broken file must fail before anything on this device is replaced
  await readBackup(file, async () => undefined);
  const serverUrl = (await db.settings.get('app'))?.serverUrl;
  const keepKv = (await db.kv.toArray()).filter((r) => PRIVATE_KV.test(r.id) && !/^(sync|account):/.test(r.id));
  const all = [...TABLES.map((t) => db[t] as Table), db.blobs];
  await db.transaction('rw', all, async () => {
    for (const t of all) await t.clear();
  });
  const batch: Record<string, Record<string, unknown>[]> = {};
  const flush = async () => {
    for (const [t, rows] of Object.entries(batch)) {
      if (rows.length) await (db[t as TableName] as Table).bulkPut(rows);
      batch[t] = [];
    }
  };
  const header = await readBackup(file, async (rec) => {
    if (rec.t === 'blob') {
      const meta = rec.r as Omit<BlobRecord, 'blob'>;
      await db.blobs.put({ ...meta, blob: base64ToBlob(rec.b64 ?? '', meta.mime) });
      return;
    }
    if (!(TABLES as readonly string[]).includes(rec.t)) return;
    if (rec.t === 'kv' && PRIVATE_KV.test(String(rec.r.id))) return;
    (batch[rec.t] ??= []).push(rec.r);
    if (batch[rec.t]!.length >= 500) await flush();
  });
  await flush();
  if (keepKv.length) await db.kv.bulkPut(keepKv);
  // a backup from before the scripted fallback may give hosts the old built-in brain
  await migrateLocalBrains(db, Date.now(), { force: true });
  const settings = await db.settings.get('app');
  if (settings && serverUrl) await db.settings.put({ ...settings, serverUrl });
  return header;
}

/** Deletes everything on this device (IndexedDB + pre-paint prefs). The caller reloads the app. */
export async function wipeLocalData(): Promise<void> {
  // The caller reloads right after; live queries and timers that still touch the closed database are expected to
  // fail until then, so keep those failures out of the console.
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (e) => {
      if ((e.reason as { name?: string } | undefined)?.name === 'DatabaseClosedError') e.preventDefault();
    });
  }
  db.close();
  await Dexie.delete(DB_NAME);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('hostcaster')) localStorage.removeItem(k);
  } catch {
    // storage blocked
  }
}
