// Your list (core/tracker) for the screens: every item on this device, live (Dexie changes from this device, from
// sync, and every trackerEvents change), plus the action waiting for the listener's yes (core/actions).
import { create } from 'zustand';
import { actionEvents, pendingAction, type ActionRecord } from '@/core/actions';
import { allItems, trackerEvents } from '@/core/tracker';
import type { TrackedItem } from '@/core/types';
import { bindLive } from './live';

interface TrackerStore {
  items: TrackedItem[];
  ready: boolean;
  /** the newest proposal still waiting for a yes or no (undefined = none) */
  pending?: ActionRecord;
  /** the last action that changed (the call-in sheet shows its result) */
  last?: ActionRecord;
  refreshPending(): Promise<void>;
}

export const useTracker = create<TrackerStore>(() => ({
  items: [],
  ready: false,
  refreshPending: async () => {
    const pending = await pendingAction().catch(() => undefined);
    useTracker.setState((s) => (s.pending?.id === pending?.id && s.pending?.status === pending?.status ? s : { pending }));
  },
}));

let started = false;

export function startTrackerStore(): void {
  if (started) return;
  started = true;
  const load = () => allItems().then((items) => useTracker.setState({ items, ready: true }));
  bindLive(allItems, (items) => useTracker.setState({ items, ready: true }));
  trackerEvents.on('change', () => void load());
  actionEvents.on('change', ({ action }) =>
    useTracker.setState((s) => {
      const waiting = action.status === 'proposed' && action.expiresAt > Date.now();
      const pending = waiting ? (!s.pending || action.createdAt >= s.pending.createdAt || s.pending.id === action.id ? action : s.pending) : s.pending?.id === action.id ? undefined : s.pending;
      return { pending, last: action };
    }),
  );
}
