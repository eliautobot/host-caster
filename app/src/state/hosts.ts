import { create } from 'zustand';
import { deleteHost, listHosts, saveHost } from '@/core/db';
import type { Draft, Host } from '@/core/types';
import { bindLive } from './live';

interface HostsStore {
  hosts: Host[];
  ready: boolean;
  save(host: Draft<Host> | Host): Promise<Host>;
  remove(id: string): Promise<void>;
}

export const useHosts = create<HostsStore>(() => ({
  hosts: [],
  ready: false,
  save: saveHost,
  remove: deleteHost,
}));

export const useHost = (id: string | undefined) => useHosts((s) => s.hosts.find((h) => h.id === id));

export const startHostsStore = () => bindLive(listHosts, (hosts) => useHosts.setState({ hosts, ready: true }));
