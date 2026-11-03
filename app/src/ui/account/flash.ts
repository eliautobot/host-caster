// What signing out did, told once after the app restarted (ui/account/signOut.ts sets it).
import { toast } from '../components/Toast';

export const FLASH_KEY = 'hostcaster:signed-out';

/** After the restart: tells what signing out did (once). */
export function announceSignOut(): void {
  let flash: string | null = null;
  try {
    flash = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
  } catch {
    return;
  }
  if (flash === 'cleared') toast.success('Signed out', 'Your stations and settings are safe in your account.');
  else if (flash === 'kept') toast.success('Signed out', 'Your hosts and stations stay on this device.');
}
