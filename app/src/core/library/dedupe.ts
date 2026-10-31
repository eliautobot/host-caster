// Duplicate detection for imports: the same file (content fingerprint), or the same song (title + artist + album
// with a duration within 2 s). Pure: the importer builds the index from the library once per import.
import type { Track } from '../types';
import { hash53, norm } from './text';

export interface DupCandidate {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** file fingerprint (fingerprint()) */
  hash?: string;
}

export const DURATION_TOLERANCE_MS = 2000;

export function songKey(c: Pick<DupCandidate, 'title' | 'artist' | 'album'>): string {
  return `${norm(c.title)}\u0000${norm(c.artist)}\u0000${norm(c.album)}`;
}

export class DuplicateIndex {
  private byHash = new Map<string, Track>();
  private bySong = new Map<string, Track[]>();

  constructor(tracks: Iterable<Track> = []) {
    for (const t of tracks) this.add(t);
  }

  add(t: Track): void {
    if (t.file?.hash) this.byHash.set(t.file.hash, t);
    if (t.source === 'stream') return;
    const k = songKey(t);
    const list = this.bySong.get(k);
    if (list) list.push(t);
    else this.bySong.set(k, [t]);
  }

  /** The library track `c` duplicates, if any. */
  find(c: DupCandidate): Track | undefined {
    if (c.hash) {
      const same = this.byHash.get(c.hash);
      if (same) return same;
    }
    if (!norm(c.title)) return undefined;
    const list = this.bySong.get(songKey(c));
    return list?.find((t) => sameDuration(t.durationMs, c.durationMs));
  }
}

export function sameDuration(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return true; // unknown duration: title/artist/album decide
  return Math.abs(a - b) <= DURATION_TOLERANCE_MS;
}

const SAMPLE = 64 * 1024;

/** Fast content fingerprint: size + first and last 64 KB. Same file = same fingerprint, in any folder or name. */
export async function fingerprint(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, SAMPLE).arrayBuffer());
  const tail = blob.size > SAMPLE * 2 ? new Uint8Array(await blob.slice(blob.size - SAMPLE).arrayBuffer()) : new Uint8Array();
  return `${blob.size.toString(36)}-${hash53(head)}${hash53(tail, 7)}`;
}
