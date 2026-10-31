import { House, Library, RadioTower, Settings, UsersRound, type LucideIcon } from 'lucide-react';

export type NavKey = 'home' | 'stations' | 'library' | 'hosts' | 'settings';

export interface NavItem {
  key: NavKey;
  label: string;
  path: string;
  icon: LucideIcon;
}

/** Main destinations, shared by the desktop sidebar and the phone tab bar. */
export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', path: '/', icon: House },
  { key: 'stations', label: 'Stations', path: '/stations', icon: RadioTower },
  { key: 'library', label: 'Library', path: '/library', icon: Library },
  { key: 'hosts', label: 'Hosts', path: '/hosts', icon: UsersRound },
  { key: 'settings', label: 'Settings', path: '/settings', icon: Settings },
];
