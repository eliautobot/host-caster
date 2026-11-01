// The desktop app's own state: its settings (ChatGPT plan on this computer, update checks, keychain) and a newer
// version when there is one. Empty everywhere else.
import { create } from 'zustand';
import { desktop, type DesktopSettings, type DesktopUpdate } from '@/core/native';

interface DesktopState {
  settings?: DesktopSettings;
  update?: DesktopUpdate;
}

export const useDesktop = create<DesktopState>(() => ({}));

/** A newer version (or none): the card in UpdateNotice and Settings, Desktop app show it. */
function tell(u: DesktopUpdate | undefined): void {
  useDesktop.setState({ update: u });
}

export function startDesktopStore(): () => void {
  if (!desktop) return () => {};
  const offs = [desktop.onSettings((settings) => useDesktop.setState({ settings })), desktop.onUpdate((u) => tell(u ?? undefined))];
  void desktop.getSettings().then((settings) => useDesktop.setState({ settings }));
  void desktop.lastUpdate().then((u) => tell(u ?? undefined));
  return () => offs.forEach((off) => off());
}

/** Settings, Desktop app: look now (shows an update even when it was put off). */
export async function checkForDesktopUpdate() {
  if (!desktop) return undefined;
  const res = await desktop.checkForUpdate();
  useDesktop.setState({ update: res.update });
  return res;
}

/** "Later": this version stays quiet for 3 days. */
export async function snoozeDesktopUpdate(): Promise<void> {
  await desktop?.snoozeUpdate();
  useDesktop.setState({ update: undefined });
}

/** Changes desktop settings (the main process saves them and tells every window). */
export async function setDesktopSettings(patch: Partial<Omit<DesktopSettings, 'keychain'>>): Promise<void> {
  if (!desktop) return;
  useDesktop.setState({ settings: await desktop.setSettings(patch) });
}
