// Music only: a scan of a phone or a folder also finds ringtones, alarms, voice notes, call recordings, podcasts and
// short sound effects. These rules leave them out (Android's MediaStore flags first, then folders, then length).
import { extOf } from '../text';
import { AUDIO_EXTS } from '../files';
import type { DeviceSong } from './types';

/** shorter than this is a sound, a jingle or a voice note, not a song */
export const MIN_SONG_MS = 30_000;

// a folder anywhere in the path with one of these names holds no music
const NOT_MUSIC_FOLDER =
  /(^|\/)(ringtones?|notifications?|alarms?|ui sounds?|recordings?|call ?recordings?|call ?rec|voice ?recorder|sound ?recorder|voice ?notes?|voice ?memos?|whatsapp (voice notes|audio)|telegram audio|podcasts?|audiobooks?|\.[^/]*)(\/|$)/i;

export type SkipReason = 'kind' | 'folder' | 'short' | 'type';

/** Why a found file is not a song (undefined = it is one). */
export function notMusic(s: Pick<DeviceSong, 'kind' | 'folder' | 'name' | 'durationMs' | 'mime'>): SkipReason | undefined {
  if (s.kind && s.kind !== 'music') return 'kind';
  if (NOT_MUSIC_FOLDER.test(s.folder)) return 'folder';
  const ext = extOf(s.name);
  if (!AUDIO_EXTS.includes(ext) && !s.mime.startsWith('audio/')) return 'type';
  if (s.durationMs > 0 && s.durationMs < MIN_SONG_MS) return 'short';
  return undefined;
}

export function musicOnly<T extends Pick<DeviceSong, 'kind' | 'folder' | 'name' | 'durationMs' | 'mime'>>(songs: T[]): T[] {
  return songs.filter((s) => !notMusic(s));
}
