// Settings sub pages registry. Add a page = add one entry (it gets a row in Settings and a /settings/:id route).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { AudioLines, BrainCircuit, Database, Palette, Plug, UserRound, Contact, type LucideIcon } from 'lucide-react';
import { Headphones, ListMusic } from 'lucide-react';
import { Eye, Monitor, Smartphone } from 'lucide-react';
import { desktopOsName, isDesktop, isNative, sellsPlans } from '@/core/native';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { api, isOnline } from '@/core/api';

export interface SettingsPageDef {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  group: 'You' | 'Radio' | 'App';
  screen: LazyExoticComponent<ComponentType>;
  /** listed only when this says so (the page still opens by its address) */
  visible?: () => boolean;
}

export const SETTINGS_GROUPS = ['You', 'Radio', 'App'] as const;

/** The hosted service's admin page; not in every copy (the public, self-hosted source leaves it out). */
const adminScreen = import.meta.glob<{ default: ComponentType }>('./Admin.tsx')['./Admin.tsx'];

export const settingsPages: SettingsPageDef[] = [
  { id: 'account', title: 'Account', description: 'Sign in, sync and your server', icon: UserRound, group: 'You',
    screen: lazy(() => import('./Account')) },
  // online edition (the hosted Host-Caster service)
  { id: 'plan', title: 'Plan and usage', description: sellsPlans ? 'Your plan, included AI and billing' : 'Your plan and included AI', icon: CreditCard, group: 'You',
    screen: lazy(() => import('./Plan')), visible: isOnline },
  ...(adminScreen ? [{ id: 'admin', title: 'Admin', description: 'Users, plans and AI spend', icon: ShieldCheck,
    group: 'App' as const, screen: lazy(adminScreen), visible: () => isOnline() && Boolean(api.session?.user.admin) }] : []),
  { id: 'about-me', title: 'About me', description: 'What your hosts know about you', icon: Contact, group: 'You',
    screen: lazy(() => import('./AboutMe')) },
  { id: 'brains', title: 'Brains', description: 'AI models your hosts think with', icon: BrainCircuit, group: 'Radio',
    screen: lazy(() => import('./Brains')) },
  { id: 'voices', title: 'Voices', description: 'Speech engines and voices', icon: AudioLines, group: 'Radio',
    screen: lazy(() => import('./Voices')) },
  { id: 'music-services', title: 'Music services', description: 'Spotify, YouTube Music, your server, internet radio',
    icon: ListMusic, group: 'Radio', screen: lazy(() => import('./MusicServices')) },
  { id: 'connections', title: 'Connections', description: 'Calendar, email, weather, news and AI apps', icon: Plug,
    group: 'Radio', screen: lazy(() => import('./Connections')) },
  { id: 'hosts-see', title: 'What your hosts can see', description: 'Your day as the hosts get it, source by source',
    icon: Eye, group: 'Radio', screen: lazy(() => import('./HostsSee')) },
  { id: 'playback', title: 'Playback', description: 'Crossfade and keyboard shortcuts', icon: Headphones, group: 'App',
    screen: lazy(() => import('./Playback')) },
  { id: 'appearance', title: 'Appearance', description: 'Theme and display', icon: Palette, group: 'App',
    screen: lazy(() => import('./Appearance')) },
  { id: 'data', title: 'Data & storage', description: 'Backups, export and reset', icon: Database, group: 'App',
    screen: lazy(() => import('./Data')) },
  // Android/iOS apps only (owner: native agent)
  ...(isNative ? [{ id: 'device', title: 'This device', description: 'Background play, permissions, any music app',
    icon: Smartphone, group: 'App' as const, screen: lazy(() => import('./Device')) }] : []),
  // the desktop app only (desktop/ in the repo)
  ...(isDesktop ? [{ id: 'desktop', title: 'Desktop app', description: `ChatGPT plan, updates and Host-Caster for ${desktopOsName()}`,
    icon: Monitor, group: 'App' as const, screen: lazy(() => import('./Desktop')) }] : []),
];

export function getSettingsPage(id: string | undefined): SettingsPageDef | undefined {
  return settingsPages.find((p) => p.id === id);
}
