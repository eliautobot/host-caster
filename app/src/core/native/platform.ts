// Which shell are we in. Everything in core/native checks `isNative` and no-ops (or uses the web API) on web.
import { Capacitor } from '@capacitor/core';
import type { Platform } from '../types';

export const isNative: boolean = Capacitor.isNativePlatform();

export const platform: Platform = isNative ? (Capacitor.getPlatform() === 'ios' ? 'ios' : 'android') : 'web';

/**
 * The phone apps sell nothing: app store payment rules (Google Play payments policy, App Store guideline 3.1.1) do
 * not allow selling Host-Caster plans with Stripe inside them. Plan cards, Checkout, prices and upgrade hints show
 * only on the web; a plan bought on the web works in the apps (same account), with its usage meters.
 */
export const sellsPlans: boolean = !isNative;

/**
 * How this Android build reaches people, set at build time (VITE_HOSTCASTER_DISTRIBUTION, app/scripts/android-release.sh):
 * 'play' for Google Play (the default), 'direct' for the APK downloaded from the website. Only a direct build checks
 * the website for a newer version (core/update); Google Play updates its own builds.
 */
export const distribution: 'play' | 'direct' = import.meta.env.VITE_HOSTCASTER_DISTRIBUTION === 'direct' ? 'direct' : 'play';

/** True when this native plugin is compiled into the running app (false on web and in older app builds). */
export function hasPlugin(name: string): boolean {
  return isNative && Capacitor.isPluginAvailable(name);
}
