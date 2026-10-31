// Picking files: <input type=file> (multi, folder via webkitdirectory) and drag and drop (folders walked).
import { extOf } from './text';
import { PLAYLIST_EXTS } from './m3u';

export const AUDIO_EXTS = ['mp3', 'm4a', 'm4b', 'aac', 'mp4', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wave', 'webm', 'weba', 'aif', 'aiff', 'caf'];

/** accept= value for audio pickers */
export const AUDIO_ACCEPT = ['audio/*', ...AUDIO_EXTS.map((e) => `.${e}`)].join(',');
export const PLAYLIST_ACCEPT = ['.m3u', '.m3u8', '.pls', 'audio/x-mpegurl', 'audio/mpegurl', 'audio/x-scpls'].join(',');

export interface PickedFile {
  file: File;
  /** relative path inside a picked/dropped folder */
  path?: string;
}

export function isAudioFile(f: File): boolean {
  const ext = extOf(f.name);
  if (AUDIO_EXTS.includes(ext)) return true;
  return f.type.startsWith('audio/') && !PLAYLIST_EXTS.includes(ext) && !f.type.includes('mpegurl');
}

export function isPlaylistFile(f: File): boolean {
  return PLAYLIST_EXTS.includes(extOf(f.name));
}

/** Folder pickers are not on iOS Safari and some Android browsers. */
export function supportsFolderPick(): boolean {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input');
  return 'webkitdirectory' in input && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function fromFileList(list: FileList | File[]): PickedFile[] {
  return [...list].map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, path: rel || undefined };
  });
}

/** Files from a drop, walking dropped folders (webkitGetAsEntry). */
export async function fromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) return fromFileList(dt.files);
  const out: PickedFile[] = [];
  for (const e of entries) await walk(e, out);
  return out;
}

async function walk(entry: FileSystemEntry, out: PickedFile[], depth = 0): Promise<void> {
  if (depth > 12) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)).catch(() => undefined);
    if (file) out.push({ file, path: entry.fullPath.replace(/^\//, '') || undefined });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns batches (100 in Chrome) until an empty one
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)).catch(() => []);
    if (!batch.length) break;
    for (const child of batch) await walk(child, out, depth + 1);
  }
}

/** Splits picked files into songs, playlist files and the rest (ignored: covers, .txt, .cue ...). */
export function sortPicked(files: PickedFile[]): { audio: PickedFile[]; playlists: PickedFile[]; ignored: number } {
  const audio: PickedFile[] = [];
  const playlists: PickedFile[] = [];
  let ignored = 0;
  for (const f of files) {
    if (f.file.name.startsWith('.')) ignored++;
    else if (isPlaylistFile(f.file)) playlists.push(f);
    else if (isAudioFile(f.file)) audio.push(f);
    else ignored++;
  }
  return { audio, playlists, ignored };
}
