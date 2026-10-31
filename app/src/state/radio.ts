import { create } from 'zustand';
import { radio } from '@/core/radio';
import type { RadioState } from '@/core/types';

/** Mirrors core radio.state for React. Call radio.* directly for actions. */
export const useRadio = create<RadioState>(() => radio.state);

export const startRadioStore = () => radio.on('state', (s) => useRadio.setState(s, true));
