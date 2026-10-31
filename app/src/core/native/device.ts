// Permissions and system settings shortcuts for Settings > This device.
import { App } from '@capacitor/app';
import { HostCasterAudio, type DeviceStatus } from './plugin';
import { hasPlugin, isNative, platform } from './platform';

export type { DeviceStatus };
export type DeviceSettingsTarget = 'app' | 'notifications' | 'battery' | 'anyapp';

/** undefined on web or when the native plugin is missing. */
export async function deviceStatus(): Promise<DeviceStatus | undefined> {
  if (!hasPlugin('HostCasterAudio')) return undefined;
  try {
    return await HostCasterAudio.deviceStatus();
  } catch {
    return undefined;
  }
}

/** Android 13+: asks for the notification permission (the playback controls live in a notification). */
export async function requestNotificationPermission(): Promise<DeviceStatus['notifications'] | undefined> {
  if (!hasPlugin('HostCasterAudio')) return undefined;
  return (await HostCasterAudio.requestNotifications()).notifications;
}

/** Opens a system settings screen for Host-Caster. iOS can only open the app's own settings page. */
export async function openDeviceSettings(target: DeviceSettingsTarget): Promise<void> {
  if (!hasPlugin('HostCasterAudio')) return;
  await HostCasterAudio.openSettings({ target: platform === 'ios' ? 'app' : target });
}

/** Runs cb each time the app comes back to the foreground (for example after a system settings screen). */
export function onAppResume(cb: () => void): () => void {
  if (!isNative) return () => {};
  let removed = false;
  let handle: { remove: () => Promise<void> } | undefined;
  void App.addListener('resume', cb).then((h) => {
    if (removed) void h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    void handle?.remove();
  };
}
