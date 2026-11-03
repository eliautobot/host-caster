#!/usr/bin/env node
// Undo a bad sync on a server you run: lists the kept versions of an account's synced doc (time and size, never the
// content), or puts the account back the way it was at one of them. The account's devices take it on their next sync.
// The online edition's admins can do the same over HTTP (GET /api/admin/sync/revisions, POST /api/admin/sync/restore).
//
//   node scripts/sync-restore.mjs <account email or id>           list the kept versions
//   node scripts/sync-restore.mjs <account email or id> <version>  restore that version
//
// Reads the same settings as the server (.env, DATA_DIR, SECRET_KEY). Safe while the server runs (SQLite WAL).
import { loadConfig, loadEnvFile } from '../src/config.js';
import { createSealer } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { listDocRevisions, readDoc, restoreDocRevision } from '../src/routes/sync.js';

const [who, version] = process.argv.slice(2);
if (!who) {
  console.error('Usage: node scripts/sync-restore.mjs <account email or id> [version]');
  process.exit(2);
}
loadEnvFile();
const config = loadConfig(process.env);
const app = { db: openDb(config.dbFile), sealer: createSealer(config.secretKey), config };
const user = app.db.prepare('SELECT id, email FROM users WHERE id = ? OR lower(email) = lower(?) LIMIT 1').get(who, who);
if (!user) {
  console.error('No such account on this server.');
  process.exit(1);
}
try {
  if (version === undefined) {
    const { rev } = readDoc(app, user.id);
    console.log(`Account ${user.email || user.id}: current version ${rev}`);
    for (const r of listDocRevisions(app, user.id)) console.log(`  version ${r.rev}  ${new Date(r.at).toISOString()}  ${r.size} characters`);
  } else {
    const out = restoreDocRevision(app, user.id, Number(version));
    console.log(`Restored version ${out.restoredFrom} as version ${out.rev}. The account's devices take it on their next sync.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  app.db.close();
}
