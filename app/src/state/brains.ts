import { create } from 'zustand';
import { deleteBrain, deleteVoiceProvider, listBrains, listVoices, saveBrain, saveVoiceProvider } from '@/core/db';
import type { Brain, VoiceProvider } from '@/core/types';
import { bindLive } from './live';

interface BrainsStore {
  brains: Brain[];
  voices: VoiceProvider[];
  ready: boolean;
  saveBrain: typeof saveBrain;
  removeBrain: typeof deleteBrain;
  saveVoice: typeof saveVoiceProvider;
  removeVoice: typeof deleteVoiceProvider;
}

export const useBrains = create<BrainsStore>(() => ({
  brains: [],
  voices: [],
  ready: false,
  saveBrain,
  removeBrain: deleteBrain,
  saveVoice: saveVoiceProvider,
  removeVoice: deleteVoiceProvider,
}));

export const startBrainsStore = () => {
  const a = bindLive(listBrains, (brains) => useBrains.setState({ brains, ready: true }));
  const b = bindLive(listVoices, (voices) => useBrains.setState({ voices }));
  return () => {
    a();
    b();
  };
};
