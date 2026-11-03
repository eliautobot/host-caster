// Signing out from the app: stop what plays, sign out (the account's data leaves this device, core/api/auth.ts), then
// start again on a clean first run and say so once the app is back.
import { auth } from '@/core/api';
import { player } from '@/core/player';
import { radio } from '@/core/radio';
import { FLASH_KEY } from './flash';

/** Stops the radio and the player (saving nothing more), then signs out. True when the account's data left this device. */
export async function signOutHere(): Promise<boolean> {
  radio.stop();
  player.forget();
  return auth.signOut();
}

/** Signs out and restarts the app (nothing of the account stays in memory either). */
export async function signOutAndRestart(): Promise<void> {
  const cleared = await signOutHere();
  try {
    sessionStorage.setItem(FLASH_KEY, cleared ? 'cleared' : 'kept');
  } catch {
    // storage blocked: the restart just says nothing
  }
  location.replace(location.pathname);
}
