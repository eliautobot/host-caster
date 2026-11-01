// App stores. Add a store: create state/<name>.ts with a start function and list it here.
import { startBrainsStore } from './brains';
import { startDesktopStore } from './desktop';
import { startHostsStore } from './hosts';
import { startLibraryStore } from './library';
import { startPlayerStore } from './player';
import { startProfileStore } from './profile';
import { startRadioStore } from './radio';
import { startSessionStore } from './session';
import { startSettingsStore } from './settings';
import { startStationsStore } from './stations';

let started = false;

export function startStores(): void {
  if (started) return;
  started = true;
  for (const start of [
    startProfileStore,
    startSettingsStore,
    startHostsStore,
    startStationsStore,
    startLibraryStore,
    startBrainsStore,
    startPlayerStore,
    startRadioStore,
    startSessionStore,
    startDesktopStore,
  ]) {
    start();
  }
}

export { useRoute, navigate, back, href, matchPath, buildPath } from './router';
export { useProfile } from './profile';
export { useSettings } from './settings';
export { useHosts, useHost } from './hosts';
export { useStations, useStation, useActiveStation } from './stations';
export { useLibrary } from './library';
export { useBrains } from './brains';
export { usePlayer } from './player';
export { useRadio } from './radio';
export { useSession, useSignedIn } from './session';
