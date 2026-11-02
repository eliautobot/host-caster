import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '@/core/api';
import { getSettings, initDb } from '@/core/db';
import { isDesktop, isNative, startNativeShell } from '@/core/native';
import { captureSpotifyRedirect } from '@/core/services/spotify/redirect';
import { startStores } from '@/state';
import { App, BootError } from './App';
import { handleNativeBack } from './ui/nativeBack';
import { defaultServerUrl } from './ui/screens/settings/account/server';
import './ui/tokens.css';
import './ui/theme.css';

// Spotify returns to /spotify/callback (a real path); turn it into the hash route before the first render.
captureSpotifyRedirect();

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    await initDb();
    const settings = await getSettings();
    // web: same origin unless a server URL is set; native: settings.serverUrl, else the default server
    api.configure({ baseUrl: settings.serverUrl ?? defaultServerUrl() });
    void api.probe();
    startStores();
    // "Keep my music up to date" (Find music on this device): looks again on start and when the app comes back
    void import('@/core/library/device').then((m) => m.startDeviceMusic());
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    console.error(err);
    root.render(<BootError error={err} />);
  }
  // Android/iOS: hide the splash after the first paint, theme the system bars, back button, deep links
  void startNativeShell({ onBack: handleNativeBack });
}

void boot();

// the desktop app has its files inside; no service worker there
if (import.meta.env.PROD && !isNative && !isDesktop && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => console.warn('[hostcaster] sw', err));
  });
}
