import { PROFILE_ID, SETTINGS_ID, type Profile, type Settings } from '../types';
import { db } from './db';
import { defaultProfile, defaultSettings } from './defaults';

export async function getProfile(): Promise<Profile> {
  return (await db.profile.get(PROFILE_ID)) ?? defaultProfile();
}

export async function saveProfile(patch: Partial<Omit<Profile, 'id'>>): Promise<Profile> {
  const next: Profile = { ...(await getProfile()), ...patch, id: PROFILE_ID, updatedAt: Date.now() };
  await db.profile.put(next);
  return next;
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get(SETTINGS_ID)) ?? defaultSettings();
}

export async function saveSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch, id: SETTINGS_ID, updatedAt: Date.now() };
  await db.settings.put(next);
  return next;
}
