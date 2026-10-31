import { migrateLegacyDb } from './legacy';
import { migrateLocalBrains } from './noBrain';
import { seedIfEmpty } from './seed';
import { HostCasterDB } from './schema';

/** The app database singleton. */
export const db = new HostCasterDB();

/** Open, move data over from the app's old name (once), seed. Call once before the first render. */
export async function initDb(): Promise<void> {
  await db.open();
  await migrateLegacyDb(db).catch((err: unknown) => console.error('[hostcaster] could not move the old data', err));
  await seedIfEmpty(db);
  await migrateLocalBrains(db).catch((err: unknown) => console.error('[hostcaster] could not move hosts off the built-in brain', err));
}
