// Library dialogs, opened from anywhere (menus, Now Playing). <LibraryDialogs /> is mounted once by the player chrome.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Check, ListPlus, Plus, Radio } from 'lucide-react';
import { addStream, addToPlaylist, createPlaylist, updatePlaylist } from '@/core/library';
import type { Playlist, Track } from '@/core/types';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { runAction } from '../actions';
import { Button, Sheet, TextArea, TextField, toast } from '../components';
import { PlaylistCover } from './covers';
import { DeviceMusicSheet } from './DeviceMusicSheet';
import { playTracks } from './play';

type Dialog =
  | { kind: 'addToPlaylist'; tracks: Track[] }
  | { kind: 'playlist'; tracks?: Track[]; edit?: Playlist }
  | { kind: 'stream' }
  | { kind: 'device' }
  | { kind: 'confirm'; title: string; description?: string; confirm: string; danger?: boolean; onConfirm: () => unknown };

const useDialogs = create<{ dialog?: Dialog }>(() => ({}));

export const dialogs = {
  addToPlaylist: (tracks: Track[]) => useDialogs.setState({ dialog: { kind: 'addToPlaylist', tracks } }),
  newPlaylist: (tracks?: Track[]) => useDialogs.setState({ dialog: { kind: 'playlist', tracks } }),
  editPlaylist: (edit: Playlist) => useDialogs.setState({ dialog: { kind: 'playlist', edit } }),
  addStream: () => useDialogs.setState({ dialog: { kind: 'stream' } }),
  /** Find music on this device / Add a music folder */
  deviceMusic: () => useDialogs.setState({ dialog: { kind: 'device' } }),
  confirm: (d: Omit<Extract<Dialog, { kind: 'confirm' }>, 'kind'>) => useDialogs.setState({ dialog: { kind: 'confirm', ...d } }),
  close: () => useDialogs.setState({ dialog: undefined }),
};

export function LibraryDialogs() {
  const dialog = useDialogs((s) => s.dialog);
  // keep the last dialog rendered while the sheet animates out
  const [last, setLast] = useState<Dialog>();
  useEffect(() => {
    if (dialog) setLast(dialog);
  }, [dialog]);
  const d = dialog ?? last;
  const open = Boolean(dialog);
  return (
    <>
      <AddToPlaylistSheet open={open && d?.kind === 'addToPlaylist'} tracks={d?.kind === 'addToPlaylist' ? d.tracks : []} />
      <PlaylistSheet open={open && d?.kind === 'playlist'} d={d?.kind === 'playlist' ? d : undefined} />
      <StreamSheet open={open && d?.kind === 'stream'} />
      <DeviceMusicSheet open={open && d?.kind === 'device'} />
      <ConfirmSheet open={open && d?.kind === 'confirm'} d={d?.kind === 'confirm' ? d : undefined} />
    </>
  );
}

function AddToPlaylistSheet({ open, tracks }: { open: boolean; tracks: Track[] }) {
  const playlists = useLibrary((s) => s.playlists);
  const editable = playlists.filter((p) => p.source === 'local' || p.source === 'm3u');
  const one = tracks.length === 1;
  const add = (p: Playlist) =>
    runAction(async () => {
      const r = await addToPlaylist(
        p.id,
        tracks.map((t) => t.id),
      );
      dialogs.close();
      toast({
        title: r.added ? `Added to ${p.name}` : `Already in ${p.name}`,
        description: r.added && r.skipped ? `${r.skipped} already there` : undefined,
        action: { label: 'View', onClick: () => navigate(`/library/playlists/${p.id}`) },
      });
    });
  return (
    <Sheet
      open={open}
      onClose={dialogs.close}
      size="sm"
      title="Add to playlist"
      description={one ? `${tracks[0]!.title} · ${tracks[0]!.artist}` : `${tracks.length} songs`}
    >
      <div className="aw-pick-list" role="list">
        <button type="button" className="aw-pick" onClick={() => dialogs.newPlaylist(tracks)}>
          <span className="aw-pick__new" aria-hidden>
            <Plus />
          </span>
          <span className="aw-pick__text">
            <span className="aw-pick__title">New playlist</span>
          </span>
        </button>
        {editable.map((p) => {
          const has = one && p.trackIds.includes(tracks[0]!.id);
          return (
            <button key={p.id} type="button" className="aw-pick" onClick={() => add(p)}>
              <PlaylistCover playlist={p} size={44} />
              <span className="aw-pick__text">
                <span className="aw-pick__title aw-truncate">{p.name}</span>
                <span className="aw-pick__meta">{p.trackIds.length} songs</span>
              </span>
              {has && <Check className="aw-pick__check" aria-label="Already added" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

function PlaylistSheet({ open, d }: { open: boolean; d?: Extract<Dialog, { kind: 'playlist' }> }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(d?.edit?.name ?? '');
    setDesc(d?.edit?.description ?? '');
  }, [open, d]);
  const save = () =>
    runAction(async () => {
      if (d?.edit) {
        await updatePlaylist(d.edit.id, { name, description: desc });
        dialogs.close();
        return;
      }
      const p = await createPlaylist(name || 'New playlist', d?.tracks?.map((t) => t.id) ?? [], desc);
      dialogs.close();
      toast({ title: `Created ${p.name}`, action: { label: 'View', onClick: () => navigate(`/library/playlists/${p.id}`) } });
    });
  return (
    <Sheet
      open={open}
      onClose={dialogs.close}
      size="sm"
      title={d?.edit ? 'Edit playlist' : 'New playlist'}
      description={d?.tracks?.length ? `With ${d.tracks.length === 1 ? `"${d.tracks[0]!.title}"` : `${d.tracks.length} songs`}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={dialogs.close}>
            Cancel
          </Button>
          <Button variant="primary" icon={d?.edit ? Check : ListPlus} onClick={save} disabled={!name.trim()}>
            {d?.edit ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="aw-form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} placeholder="Sunday morning" data-autofocus maxLength={80} />
        <TextArea label="Description" value={desc} onChange={setDesc} placeholder="Optional" rows={2} autoResize maxLength={300} />
      </form>
    </Sheet>
  );
}

function StreamSheet({ open }: { open: boolean }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setUrl('');
      setName('');
      setError(undefined);
    }
  }, [open]);
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const t = await addStream(url, name);
      dialogs.close();
      toast({ title: `Added ${t.title}`, description: 'Internet radio is in your library.', action: { label: 'Play', onClick: () => playTracks([t]) } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={dialogs.close}
      size="sm"
      title="Add internet radio"
      description="Paste a stream address (.mp3, .aac, .m3u, .pls). It plays as an endless track."
      footer={
        <>
          <Button variant="ghost" onClick={dialogs.close}>
            Cancel
          </Button>
          <Button variant="primary" icon={Radio} loading={busy} disabled={!url.trim()} onClick={() => void add()}>
            Add station
          </Button>
        </>
      }
    >
      <form
        className="aw-form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void add();
        }}
      >
        <TextField
          label="Stream address"
          value={url}
          onChange={setUrl}
          placeholder="https://stream.example.com/live.mp3"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          error={error}
          data-autofocus
        />
        <TextField label="Name" value={name} onChange={setName} placeholder="Optional, e.g. Jazz FM" maxLength={80} />
      </form>
    </Sheet>
  );
}

function ConfirmSheet({ open, d }: { open: boolean; d?: Extract<Dialog, { kind: 'confirm' }> }) {
  return (
    <Sheet
      open={open}
      onClose={dialogs.close}
      size="sm"
      title={d?.title}
      description={d?.description}
      footer={
        <>
          <Button variant="ghost" onClick={dialogs.close} data-autofocus>
            Cancel
          </Button>
          <Button
            variant={d?.danger ? 'danger' : 'primary'}
            onClick={() =>
              runAction(async () => {
                dialogs.close();
                await d?.onConfirm();
              })
            }
          >
            {d?.confirm}
          </Button>
        </>
      }
    />
  );
}

