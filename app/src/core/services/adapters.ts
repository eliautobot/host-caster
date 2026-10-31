// Service PlayerAdapters (owner: services builder). The player registers them all:
//   for (const a of serviceAdapters()) player.registerAdapter(a)
// Subsonic and internet radio need no adapter: they are plain URLs for the audio element (see resolve.ts).
import type { PlayerAdapter } from '../types';
import { SpotifyAdapter } from './spotify/adapter';
import { initSpotifyNative } from './spotify/auth';
import { YouTubeAdapter } from './youtube/adapter';

export const youtubeAdapter = new YouTubeAdapter();
export const spotifyAdapter = new SpotifyAdapter();

let booted = false;

export function serviceAdapters(): PlayerAdapter[] {
  if (!booted) {
    booted = true;
    initSpotifyNative(); // native: a cold-start hostcaster://spotify deep link finishes the sign-in
  }
  return [youtubeAdapter, spotifyAdapter];
}

// debugging + e2e (same pattern as the player and radio singletons)
if (typeof window !== 'undefined') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  (w.__hostcaster ??= {}).services = { youtube: youtubeAdapter, spotify: spotifyAdapter };
}
