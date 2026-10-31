import { PROFILE_ID, SETTINGS_ID } from '../types';
import { defaultProfile, defaultSettings, STARTER_HOSTS, STARTER_STATION } from './defaults';
import type { HostCasterDB } from './schema';

/**
 * First run: profile row, settings row, starter hosts and station. Idempotent; only seeds starter content when the
 * settings row is missing (a deleted starter host stays deleted).
 */
export async function seedIfEmpty(db: HostCasterDB, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', [db.settings, db.profile, db.hosts, db.stations], async () => {
    if (!(await db.profile.get(PROFILE_ID))) await db.profile.put(defaultProfile(now));
    if (await db.settings.get(SETTINGS_ID)) return false;
    // stagger createdAt so list order follows the seed order
    await db.hosts.bulkPut(STARTER_HOSTS.map((h, i) => ({ ...h, createdAt: now + i, updatedAt: now + i })));
    await db.stations.put({ ...STARTER_STATION, createdAt: now, updatedAt: now });
    await db.settings.put(defaultSettings(now));
    return true;
  });
}
