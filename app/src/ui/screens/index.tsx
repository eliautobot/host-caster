// Screens registry. Add a screen = add one line here (path, lazy import, nav highlight, presentation).
// Order matters: the first matching path wins, so put specific paths before general ones.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { matchPath } from '@/state/router';
import type { NavKey } from '../layout/nav';

export interface ScreenProps {
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface ScreenDef {
  path: string;
  screen: LazyExoticComponent<ComponentType<ScreenProps>>;
  title: string;
  /** which sidebar/tab item is highlighted */
  nav?: NavKey;
  /** page = inside the shell; sheet = full-screen sheet over the last page; bare = no shell (onboarding) */
  presentation?: 'page' | 'sheet' | 'bare';
}

export const screens: ScreenDef[] = [
  { path: '/', title: 'Home', nav: 'home', screen: lazy(() => import('./Home')) },
  { path: '/now-playing', title: 'Now Playing', presentation: 'sheet', screen: lazy(() => import('./NowPlaying')) },
  { path: '/stations', title: 'Stations', nav: 'stations', screen: lazy(() => import('./Stations')) },
  { path: '/stations/:id', title: 'Station', nav: 'stations', screen: lazy(() => import('./StationEdit')) },
  { path: '/library', title: 'Library', nav: 'library', screen: lazy(() => import('./Library')) },
  { path: '/library/playlists/:id', title: 'Playlist', nav: 'library', screen: lazy(() => import('./Playlist')) },
  { path: '/library/albums/:id', title: 'Album', nav: 'library', screen: lazy(() => import('./Album')) },
  { path: '/library/artists/:id', title: 'Artist', nav: 'library', screen: lazy(() => import('./Artist')) },
  { path: '/library/liked', title: 'Liked songs', nav: 'library', screen: lazy(() => import('./LikedSongs')) },
  { path: '/library/search', title: 'Search', nav: 'library', screen: lazy(() => import('./LibrarySearch')) },
  { path: '/services/spotify/callback', title: 'Spotify', nav: 'settings', screen: lazy(() => import('./services/SpotifyCallback')) },
  { path: '/services/:kind', title: 'Music services', nav: 'library', screen: lazy(() => import('./services/ServiceBrowse')) },
  { path: '/on-air', title: 'On-air history', nav: 'home', screen: lazy(() => import('./OnAirHistory')) },
  { path: '/hosts', title: 'Hosts', nav: 'hosts', screen: lazy(() => import('./Hosts')) },
  { path: '/hosts/:id', title: 'Host', nav: 'hosts', screen: lazy(() => import('./HostEdit')) },
  { path: '/settings', title: 'Settings', nav: 'settings', screen: lazy(() => import('./Settings')) },
  { path: '/settings/:page', title: 'Settings', nav: 'settings', screen: lazy(() => import('./Settings')) },
  { path: '/welcome', title: 'Welcome', presentation: 'bare', screen: lazy(() => import('./Onboarding')) },
  { path: '/sign-in', title: 'Sign in', presentation: 'bare', screen: lazy(() => import('./SignIn')) },
  { path: '/plans', title: 'Plans', presentation: 'bare', screen: lazy(() => import('./Plans')) },
  { path: '/dev/components', title: 'Components', screen: lazy(() => import('./DevComponents')) },
];

export const notFoundScreen: ScreenDef = { path: '*', title: 'Not found', screen: lazy(() => import('./NotFound')) };

export interface ScreenMatch {
  def: ScreenDef;
  params: Record<string, string>;
}

export function resolveScreen(path: string): ScreenMatch {
  for (const def of screens) {
    const params = matchPath(def.path, path);
    if (params) return { def, params };
  }
  return { def: notFoundScreen, params: {} };
}
