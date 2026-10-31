// Is the app on screen? Phone apps: Capacitor's appStateChange (Android fires it when the activity starts and stops,
// so the home button, the screen turning off and another app on top all count as off screen). Web: no events.
import { App } from '@capacitor/app';
import { isNative } from './platform';

/** Calls `cb(false)` when the app leaves the screen and `cb(true)` when it is back. No-op on web. */
export function onScreenChange(cb: (onScreen: boolean) => void): () => void {
  if (!isNative) return () => {};
  let removed = false;
  let handle: { remove: () => Promise<void> } | undefined;
  void App.addListener('appStateChange', (s) => cb(s.isActive)).then((h) => {
    if (removed) void h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    void handle?.remove();
  };
}
