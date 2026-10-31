// Importing songs from files into IndexedDB: tags + cover via music-metadata, duplicate check, progress events.
import { db, getBlob, putBlob, saveTracks } from '../db';
import type { Draft, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { DuplicateIndex, fingerprint } from './dedupe';
import { sortPicked, type PickedFile } from './files';
import { readSongMeta } from './metadata';
import { importPlaylistText } from './playlists';
import { extOf, hash53 } from './text';

export interface ImportProgress {
  running: boolean;
  total: number;
  done: number;
  added: number;
  duplicates: number;
  failed: number;
  playlists: number;
  /** file being read right now */
  current?: string;
  /** set when the browser ran out of storage */
  storageFull?: boolean;
  errors: string[];
}

const IDLE: ImportProgress = { running: false, total: 0, done: 0, added: 0, duplicates: 0, failed: 0, playlists: 0, errors: [] };
const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
};

class Importer {
  private emitter = createEmitter<{ progress: ImportProgress; added: Track }>();
  private _state: ImportProgress = IDLE;
  private chain: Promise<unknown> = Promise.resolve();

  get state(): ImportProgress {
    return this._state;
  }

  on = this.emitter.on.bind(this.emitter);

  private set(patch: Partial<ImportProgress>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('progress', this._state);
  }

  /** Imports songs (and playlist files found next to them). Imports queue up; the promise resolves when done. */
  import(files: PickedFile[]): Promise<ImportProgress> {
    const run = this.chain.then(() => this.run(files));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async run(files: PickedFile[]): Promise<ImportProgress> {
    const { audio, playlists } = sortPicked(files);
    this.set({ ...IDLE, running: true, total: audio.length, errors: [] });
    void navigator.storage?.persist?.().catch(() => undefined);
    const index = new DuplicateIndex(await db.tracks.toArray());
    let next = 0;
    const worker = async () => {
      while (next < audio.length && !this._state.storageFull) {
        const item = audio[next++]!;
        this.set({ current: item.file.name });
        try {
          const track = await importOne(item, index);
          if (track) {
            this.set({ added: this._state.added + 1 });
            this.emitter.emit('added', track);
          } else this.set({ duplicates: this._state.duplicates + 1 });
        } catch (err) {
          const full = err instanceof DOMException && err.name === 'QuotaExceededError';
          this.set({
            failed: this._state.failed + 1,
            storageFull: full || this._state.storageFull,
            errors: [...this._state.errors, `${item.file.name}: ${err instanceof Error ? err.message : String(err)}`].slice(-20),
          });
        }
        this.set({ done: this._state.done + 1 });
      }
    };
    await Promise.all([worker(), worker()]);
    for (const pl of playlists) {
      try {
        const text = await pl.file.text();
        await importPlaylistText(pl.file.name, text);
        this.set({ playlists: this._state.playlists + 1 });
      } catch (err) {
        console.warn('[hostcaster] playlist import failed', pl.file.name, err);
      }
    }
    this.set({ running: false, current: undefined });
    return this._state;
  }
}

async function importOne(item: PickedFile, index: DuplicateIndex): Promise<Track | undefined> {
  const { file } = item;
  const hash = await fingerprint(file);
  if (index.find({ title: '', artist: '', album: '', durationMs: 0, hash })) return undefined;
  const meta = await readSongMeta(file);
  if (index.find({ ...meta, hash })) return undefined;

  let artworkId: string | undefined;
  if (meta.picture) {
    artworkId = `art-${hash53(meta.picture.data)}`;
    if (!(await getBlob(artworkId))) {
      await putBlob(new Blob([meta.picture.data as Uint8Array<ArrayBuffer>], { type: meta.picture.mime }), artworkId);
    }
  }
  const mime = file.type || MIME_BY_EXT[extOf(file.name)] || 'audio/mpeg';
  const audio = await putBlob(file.type ? file : new Blob([file], { type: mime }));
  const now = Date.now();
  const draft: Draft<Track> = {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    albumArtist: meta.albumArtist,
    year: meta.year,
    genre: meta.genre,
    trackNo: meta.trackNo,
    discNo: meta.discNo,
    durationMs: meta.durationMs,
    artworkId,
    source: 'local',
    ref: audio.id,
    playCount: 0,
    addedAt: now,
    file: { name: file.name, path: item.path, size: file.size, mime, hash },
  };
  const [track] = await saveTracks([draft]);
  index.add(track!);
  return track;
}

export const importer = new Importer();
