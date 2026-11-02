// Getting music in: file/folder/playlist pickers, the "Add music" menu, import progress and drag and drop.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloudDownload, FileMusic, FolderOpen, FolderSearch, ListMusic, Plug, Plus, Radio, Server, Upload } from 'lucide-react';
import {
  AUDIO_ACCEPT,
  PLAYLIST_ACCEPT,
  fromDataTransfer,
  fromFileList,
  importPlaylistText,
  importer,
  serverLibraryAvailable,
  supportsFolderPick,
  syncServerLibrary,
  type ImportProgress,
  type PickedFile,
} from '@/core/library';
import { devicePlatform } from '@/core/library/device';
import { navigate } from '@/state/router';
import { runAction } from '../actions';
import { Button, toast } from '../components';
import { ActionMenu, type MenuItem } from './ActionMenu';
import { deviceMusicLabel } from './DeviceMusicSheet';
import { dialogs } from './dialogs';

export function useImportProgress(): ImportProgress {
  return useSyncExternalStore(
    (cb) => importer.on('progress', cb),
    () => importer.state,
  );
}

/** Imports picked/dropped files and reports the result in a toast. */
export async function importAndReport(files: PickedFile[]): Promise<void> {
  if (!files.length) return;
  const r = await importer.import(files);
  const bits: string[] = [];
  if (r.duplicates) bits.push(`${r.duplicates} already in your library`);
  if (r.failed) bits.push(`${r.failed} could not be read`);
  if (r.playlists) bits.push(`${r.playlists} playlist${r.playlists === 1 ? '' : 's'} added`);
  if (r.storageFull) {
    toast.error('This device is out of storage', 'Some songs were not added. Free up space and try again.');
  } else if (r.added) {
    toast.success(`Added ${r.added} song${r.added === 1 ? '' : 's'}`, bits.join(' · ') || undefined);
  } else if (r.total === 0 && !r.playlists) {
    toast({ title: 'No music found', description: 'Pick audio files like MP3, M4A, FLAC, OGG or WAV.' });
  } else {
    toast({ title: r.playlists && !r.total ? 'Playlist imported' : 'Nothing new to add', description: bits.join(' · ') || undefined });
  }
}

async function importPlaylistFiles(files: FileList) {
  for (const f of [...files]) {
    await runAction(async () => {
      const r = await importPlaylistText(f.name, await f.text());
      toast({
        title: `Imported ${r.playlist.name}`,
        description: `${r.matched} song${r.matched === 1 ? '' : 's'} matched${r.missing.length ? ` · ${r.missing.length} not in your library` : ''}`,
        action: { label: 'View', onClick: () => navigate(`/library/playlists/${r.playlist.id}`) },
      });
    });
  }
}

/** Hidden inputs + open functions. Render `inputs` once where the picker is used. */
export function usePickers() {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const lists = useRef<HTMLInputElement>(null);
  const reset = (el: HTMLInputElement) => {
    el.value = '';
  };
  const inputs = (
    <>
      <input
        ref={files}
        type="file"
        multiple
        accept={AUDIO_ACCEPT}
        hidden
        data-testid="pick-files"
        onChange={(e) => {
          const picked = e.currentTarget.files ? fromFileList(e.currentTarget.files) : [];
          reset(e.currentTarget);
          void importAndReport(picked);
        }}
      />
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        data-testid="pick-folder"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => {
          const picked = e.currentTarget.files ? fromFileList(e.currentTarget.files) : [];
          reset(e.currentTarget);
          void importAndReport(picked);
        }}
      />
      <input
        ref={lists}
        type="file"
        multiple
        accept={PLAYLIST_ACCEPT}
        hidden
        data-testid="pick-playlist"
        onChange={(e) => {
          const f = e.currentTarget.files;
          if (f) void importPlaylistFiles(f).finally(() => lists.current && reset(lists.current));
        }}
      />
    </>
  );
  return {
    inputs,
    pickFiles: () => files.current?.click(),
    pickFolder: () => folder.current?.click(),
    pickPlaylist: () => lists.current?.click(),
    canPickFolder: supportsFolderPick(),
  };
}

export function syncServer() {
  return runAction(async () => {
    const r = await syncServerLibrary();
    if (!r.available) toast({ title: 'No music server', description: 'Sign in to a Host-Caster server with a music folder to use it here.' });
    else toast.success(`Server library: ${r.count} songs`, r.added || r.removed ? `${r.added} new · ${r.removed} removed` : 'Up to date');
  });
}

export function addMusicItems(p: ReturnType<typeof usePickers>): MenuItem[] {
  const device = deviceMusicLabel(devicePlatform());
  return [
    { icon: FileMusic, label: 'Add songs', onSelect: p.pickFiles },
    { icon: FolderSearch, label: device ?? '', onSelect: dialogs.deviceMusic, hidden: !device },
    { icon: FolderOpen, label: 'Add a folder', onSelect: p.pickFolder, hidden: !p.canPickFolder },
    { icon: Radio, label: 'Add internet radio', onSelect: dialogs.addStream },
    { icon: ListMusic, label: 'Import a playlist file', onSelect: p.pickPlaylist },
    { icon: Plug, label: 'From a music service', onSelect: () => navigate('/settings/music-services') },
    { icon: Plus, label: 'New playlist', onSelect: () => dialogs.newPlaylist() },
    { icon: Server, label: 'Sync server library', onSelect: () => void syncServer(), hidden: !serverLibraryAvailable() },
  ];
}

export function AddMusicButton({ pickers, compact }: { pickers: ReturnType<typeof usePickers>; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={btn}
        variant="primary"
        icon={Plus}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={compact ? 'aw-addmusic--compact' : undefined}
      >
        Add music
      </Button>
      <ActionMenu open={open} onClose={() => setOpen(false)} anchor={btn.current} items={addMusicItems(pickers)} label="Add music" />
    </>
  );
}

/** Progress while importing, then a short "done" state. */
export function ImportProgressCard() {
  const p = useImportProgress();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (p.running) setShown(true);
    else if (shown) {
      const t = setTimeout(() => setShown(false), 2500);
      return () => clearTimeout(t);
    }
  }, [p.running, shown]);
  if (!shown) return null;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  return (
    <div className="aw-import" role="status" aria-live="polite">
      <div className="aw-import__icon" aria-hidden>
        {p.running ? <CloudDownload /> : <Upload />}
      </div>
      <div className="aw-import__body">
        <p className="aw-import__title">
          {p.running ? `Adding ${Math.min(p.done + 1, p.total)} of ${p.total}` : `Added ${p.added} song${p.added === 1 ? '' : 's'}`}
        </p>
        <p className="aw-import__meta aw-truncate">
          {p.running
            ? p.current
            : [p.duplicates && `${p.duplicates} already here`, p.failed && `${p.failed} unreadable`].filter(Boolean).join(' · ') || 'All done'}
        </p>
        <div className="aw-import__bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

/** Desktop: drop songs or folders anywhere in the window. */
export function DropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const dt = e.dataTransfer;
      void fromDataTransfer(dt).then(importAndReport);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!over) return null;
  return createPortal(
    <div className="aw-drop" aria-hidden>
      <div className="aw-drop__card">
        <span className="aw-drop__icon">
          <Upload />
        </span>
        <p className="aw-drop__title">Drop to add to your library</p>
        <p className="aw-drop__desc">Songs, whole folders and M3U or PLS playlists</p>
      </div>
    </div>,
    document.body,
  );
}

export function PickerButton({ icon, children, onClick }: { icon: typeof Plus; children: ReactNode; onClick: () => void }) {
  return (
    <Button icon={icon} onClick={onClick}>
      {children}
    </Button>
  );
}
