// Which shell are we in. Everything in core/native checks `isNative` and no-ops (or uses the web API) on web.
import { Capacitor } from '@capacitor/core';
import type { Platform } from '../types';

export const isNative: boolean = Capacitor.isNativePlatform();

export const platform: Platform = isNative ? (Capacitor.getPlatform() === 'ios' ? 'ios' : 'android') : 'web';

/**
 * The phone apps sell nothing: app store payment rules (Google Play payments policy, App Store guideline 3.1.1) do
 * not allow selling Host-Caster plans with Stripe inside them. Plan cards, Checkout and prices show only on the web
 * (and the desktop app, which opens Checkout in the browser); a plan bought on the web works in the apps (same account),
 * with its usage meters. The phone apps link to the website instead (planLink).
 */
export const sellsPlans: boolean = !isNative;

/**
 * How this Android build reaches people, set at build time (VITE_HOSTCASTER_DISTRIBUTION, app/scripts/android-release.sh):
 * 'play' for Google Play (the default), 'direct' for the APK downloaded from the website. Only a direct build checks
 * the website for a newer version (core/update); Google Play updates its own builds.
 */
export const distribution: 'play' | 'direct' = import.meta.env.VITE_HOSTCASTER_DISTRIBUTION === 'direct' ? 'direct' : 'play';

const PLAN_LINK = import.meta.env.VITE_HOSTCASTER_PLAN_LINK;
/**
 * The phone apps' link to the website for plans, set at build time (VITE_HOSTCASTER_PLAN_LINK):
 * 'on' = "See plans on host-caster.com" / "Manage your plan on host-caster.com" and a line that plans are bought on
 * the website; 'account' = a neutral "Open your account on host-caster.com" that does not mention buying; 'off' = no
 * link (the app only says what the account includes). Default: 'on' for the direct APK, 'off' for store builds
 * (Google Play, App Store) until that store's and region's rules for links to outside purchases are checked.
 */
export const planLink: 'on' | 'account' | 'off' =
  PLAN_LINK === 'on' || PLAN_LINK === 'account' || PLAN_LINK === 'off' ? PLAN_LINK : isNative && distribution !== 'direct' ? 'off' : 'on';

/** This app sends people to the website for plans (it sells none itself). */
export const linksToPlans: boolean = !sellsPlans && planLink !== 'off';

/** True when this native plugin is compiled into the running app (false on web and in older app builds). */
export function hasPlugin(name: string): boolean {
  return isNative && Capacitor.isPluginAvailable(name);
}
