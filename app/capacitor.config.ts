import type { CapacitorConfig } from '@capacitor/cli';

// Native shells (Android + iOS). The web build is copied in with `npx cap copy` / `npx cap sync`.
// HOSTCASTER_WEB_DIR lets a build use another output folder (for example a test build outside app/dist).
const config: CapacitorConfig = {
  appId: 'com.hostcaster.app',
  appName: 'Host-Caster',
  webDir: process.env.HOSTCASTER_WEB_DIR || 'dist',
  backgroundColor: '#0a0a0b',
  loggingBehavior: 'debug',
  android: {
    // Self-hosted servers and local AI/voice boxes often speak plain http on the LAN.
    allowMixedContent: true,
    backgroundColor: '#0a0a0b',
  },
  ios: {
    backgroundColor: '#0a0a0b',
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // fetch/XHR go through the native HTTP stack: no CORS, LAN and localhost work. Binary POST responses
    // need core/native nativeFetch (the stock patch reads them as text).
    CapacitorHttp: { enabled: true },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'DARK',
    },
    SplashScreen: {
      launchAutoHide: false,
      launchShowDuration: 3000,
      backgroundColor: '#0a0a0b',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: false,
      splashImmersive: false,
    },
  },
};

export default config;
