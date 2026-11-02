// Which scanner this app has: Android (MediaStore), the desktop app (music folders), or Chrome/Edge on a computer (a
// folder the browser keeps access to). Elsewhere (Safari, Firefox, phone browsers, iPhone) there is none and the option
// stays hidden. Scanners load on first use.
import { desktop, hasPlugin, isDesktop, isNative, platform } from '../../native';
import type { DevicePlatform, DeviceScanner } from './types';

/** Chrome and Edge on a computer: a folder picker whose access the browser can keep. */
export function webFoldersSupported(): boolean {
  if (typeof window === 'undefined' || isNative || isDesktop) return false;
  const w = window as unknown as { showDirectoryPicker?: unknown; isSecureContext?: boolean };
  let top = true;
  try {
    top = window.top === window;
  } catch {
    top = false;
  }
  return typeof w.showDirectoryPicker === 'function' && Boolean(w.isSecureContext) && top && typeof FileSystemHandle !== 'undefined';
}

/** The kind of device music this app can find (undefined = none here). */
export function devicePlatform(): DevicePlatform | undefined {
  if (isNative) return platform === 'android' && hasPlugin('HostCasterDeviceMusic') ? 'android' : undefined;
  if (isDesktop) return desktop?.music ? 'desktop' : undefined;
  return webFoldersSupported() ? 'web' : undefined;
}

/** The scanner for songs added on `p`; a song from another kind of device (a backup) has none here. */
export async function scannerFor(p: string | undefined = devicePlatform()): Promise<DeviceScanner | undefined> {
  if (!p || p !== devicePlatform()) return undefined;
  switch (p) {
    case 'android':
      return (await import('./android')).androidScanner;
    case 'desktop':
      return (await import('./desktop')).desktopScanner;
    case 'web':
      return (await import('./web')).webScanner;
    default:
      return undefined;
  }
}
