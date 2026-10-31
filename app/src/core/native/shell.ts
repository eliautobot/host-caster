// App shell glue for Android/iOS: splash, status/navigation bar colours that follow the theme, hardware back
// button, deep links. Call once after the first render; does nothing on web.
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { startDeepLinks } from './links';
import { isNative, platform } from './platform';

export interface NativeShellOptions {
  /**
   * Android back button. Return true when handled (closed a sheet, went back a page); false on the home
   * screen, which sends the app to the background (music keeps playing) instead of closing it.
   */
  onBack?: () => boolean;
}

let started = false;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function applyBars(): void {
  const light = document.documentElement.dataset.theme === 'light';
  // Dark = light icons on a dark background
  void SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {});
}

export async function startNativeShell(opts: NativeShellOptions = {}): Promise<void> {
  if (!isNative || started) return;
  started = true;
  startDeepLinks();

  applyBars();
  new MutationObserver(applyBars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  if (platform === 'android') {
    void App.addListener('backButton', () => {
      let handled = false;
      try {
        handled = opts.onBack?.() ?? false;
      } catch (err) {
        console.error('[hostcaster] back handler failed', err);
      }
      if (!handled) void App.minimizeApp();
    });
  }

  // Test builds (VITE_HOSTCASTER_DEBUG=1) also expose native, library and db next to player/radio for CDP checks.
  if (import.meta.env.VITE_HOSTCASTER_DEBUG === '1') {
    const [native, library, db, api] = await Promise.all([import('./index'), import('../library'), import('../db'), import('../api')]);
    const g = globalThis as { __hostcaster?: Record<string, unknown> };
    Object.assign((g.__hostcaster ??= {}), { native, library, db, api });
  }

  // two frames: the first paint of the real UI is on screen before the splash fades
  await frame();
  await frame();
  await SplashScreen.hide({ fadeOutDuration: 180 }).catch(() => {});
}
