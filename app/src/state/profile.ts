import { create } from 'zustand';
import { defaultProfile, getProfile, saveProfile } from '@/core/db';
import type { Profile } from '@/core/types';
import { bindLive } from './live';

interface ProfileStore {
  profile: Profile;
  ready: boolean;
  update(patch: Partial<Omit<Profile, 'id'>>): Promise<Profile>;
}

export const useProfile = create<ProfileStore>(() => ({
  profile: defaultProfile(),
  ready: false,
  update: saveProfile,
}));

export const startProfileStore = () => bindLive(getProfile, (profile) => useProfile.setState({ profile, ready: true }));
