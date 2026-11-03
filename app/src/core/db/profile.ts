import { PROFILE_ID, SETTINGS_ID, type Profile, type Settings } from '../types';
import { db } from './db';
import { defaultProfile, defaultSettings } from './defaults';
import { sameContent } from '../util/stable';

export async function getProfile(): Promise<Profile> {
  return (await db.profile.get(PROFILE_ID)) ?? defaultProfile();
}

/** Patches the profile; a patch that changes nothing keeps updatedAt (not an edit, so it never wins a merge). */
export async function saveProfile(patch: Partial<Omit<Profile, 'id'>>): Promise<Profile> {
  const prev = await getProfile();
  if (sameContent(prev, { ...prev, ...patch })) return prev;
  const next: Profile = { ...prev, ...patch, id: PROFILE_ID, updatedAt: Date.now() };
  await db.profile.put(next);
  return next;
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get(SETTINGS_ID)) ?? defaultSettings();
}

export async function saveSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const prev = await getSettings();
  if (sameContent(prev, { ...prev, ...patch })) return prev;
  const next: Settings = { ...prev, ...patch, id: SETTINGS_ID, updatedAt: Date.now() };
  await db.settings.put(next);
  return next;
}
