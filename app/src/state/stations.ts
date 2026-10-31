import { create } from 'zustand';
import { deleteStation, listStations, saveStation } from '@/core/db';
import type { Draft, Station } from '@/core/types';
import { bindLive } from './live';
import { useSettings } from './settings';

interface StationsStore {
  stations: Station[];
  ready: boolean;
  save(station: Draft<Station> | Station): Promise<Station>;
  remove(id: string): Promise<void>;
}

export const useStations = create<StationsStore>(() => ({
  stations: [],
  ready: false,
  save: saveStation,
  remove: deleteStation,
}));

export const useStation = (id: string | undefined) => useStations((s) => s.stations.find((x) => x.id === id));

/** The station in settings.activeStationId, else the first one. */
export function useActiveStation(): Station | undefined {
  const activeId = useSettings((s) => s.settings.activeStationId);
  return useStations((s) => s.stations.find((x) => x.id === activeId) ?? s.stations[0]);
}

export const startStationsStore = () =>
  bindLive(listStations, (stations) => useStations.setState({ stations, ready: true }));
