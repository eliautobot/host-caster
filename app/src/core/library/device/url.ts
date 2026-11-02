// Track.ref of a device song -> playable URL (the player's resolveTrackUrl, case 'device').
import type { Track } from '../../types';
import { refPlatform } from './plan';
import { scannerFor } from './scanners';

export async function deviceSongUrl(track: Track): Promise<string> {
  const scanner = await scannerFor(refPlatform(track.ref));
  if (!scanner) throw new Error(`"${track.title}" is a file on another device`);
  return scanner.url(track.ref);
}
