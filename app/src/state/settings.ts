import { create } from 'zustand';
import { defaultSettings, getSettings, saveSettings } from '@/core/db';
import type { Settings } from '@/core/types';
import { bindLive } from './live';

interface SettingsStore {
  settings: Settings;
  ready: boolean;
  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings>;
}

export const useSettings = create<SettingsStore>(() => ({
  settings: defaultSettings(),
  ready: false,
  update: saveSettings,
}));

export const startSettingsStore = () =>
  bindLive(getSettings, (settings) => useSettings.setState({ settings, ready: true }));
