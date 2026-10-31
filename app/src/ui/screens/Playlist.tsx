import { useMemo, useRef, useState } from 'react';
import { Check, Download, Ellipsis, ListEnd, ListMusic, Pencil, Trash2 } from 'lucide-react';
import { formatTotal, playlistFileName, playlistToM3U, plural, removeFromPlaylist, removePlaylist, reorderPlaylist } from '@/core/library';
import type { Track } from '@/core/types';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { runAction } from '../actions';
import { Button, EmptyState, IconButton, toast } from '../components';
import { Page } from '../layout/Page';
import { ActionMenu } from '../library/ActionMenu';
import { CollectionHero } from '../library/CollectionHero';
import { PlaylistCover } from '../library/covers';
import { dialogs } from '../library/dialogs';
import { addToQueue } from '../library/play';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';

/** One playlist (owner: player agent): play, reorder, remove songs, rename, export M3U, delete. */
export default function Playlist({ params }: ScreenProps) {
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === params.id));
  const all = useLibrary((s) => s.tracks);
  const ready = useLibrary((s) => s.ready);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);

  // the list shows songs that are here (a file from another device keeps its place in trackIds, unseen); indexMap maps
  // list rows back to playlist.trackIds positions
  const { tracks, indexMap } = useMemo(() => {
    const out: Track[] = [];
    const map: number[] = [];
    if (!playlist) return { tracks: out, indexMap: map };
    const byId = new Map(all.map((t) => [t.id, t]));
    playlist.trackIds.forEach((id, k) => {
      const t = byId.get(id);
      if (t) {
        out.push(t);
        map.push(k);
      }
    });
    return { tracks: out, indexMap: map };
  }, [playlist, all]);
  const missing = playlist ? playlist.trackIds.length - tracks.length : 0;

  if (!playlist) {
    return (
      <Page back="/library?tab=playlists" title="Playlist">
        {ready && <EmptyState icon={ListMusic} title="Playlist not found" description="It may have been deleted." />}
      </Page>
    );
  }

  const exportFile = () => {
    const text = playlistToM3U(playlist, tracks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
    a.download = playlistFileName(playlist.name);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast({ title: `Saved ${a.download}` });
  };

  const total = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const realIndex = (i: number) => indexMap[i] ?? i;

  return (
    <Page>
      <CollectionHero
        kind={playlist.source === 'm3u' ? 'Imported playlist' : 'Playlist'}
        title={playlist.name}
        description={playlist.description}
        meta={
          <>
            <strong>{tracks.length} song{tracks.length === 1 ? '' : 's'}</strong>
            {total > 0 && `, ${formatTotal(total)}`}
            {/* files added on another device stay there; synced songs arrive with the next sync */}
            {missing > 0 && ` · ${plural(missing, 'song')} on another device`}
          </>
        }
        cover={<PlaylistCover playlist={playlist} fluid radius={14} />}
        colorFrom={tracks.find((t) => t.artworkId)?.artworkId}
        tracks={tracks}
        backTo="/library?tab=playlists"
        actions={
          <>
            {editing ? (
              <Button size="lg" variant="accent" icon={Check} onClick={() => setEditing(false)}>
                Done
              </Button>
            ) : (
              <IconButton icon={Pencil} label="Edit songs" size="lg" variant="solid" disabled={!tracks.length} onClick={() => setEditing(true)} />
            )}
            <IconButton ref={moreBtn} icon={Ellipsis} label="More" size="lg" variant="solid" aria-haspopup="menu" onClick={() => setMenu((m) => !m)} />
            <ActionMenu
              open={menu}
              onClose={() => setMenu(false)}
              anchor={moreBtn.current}
              label="Playlist actions"
              items={[
                { icon: ListEnd, label: 'Add to queue', onSelect: () => void addToQueue(tracks), hidden: !tracks.length },
                { icon: Pencil, label: 'Rename', onSelect: () => dialogs.editPlaylist(playlist) },
                { icon: Download, label: 'Export as M3U', onSelect: exportFile },
                {
                  icon: Trash2,
                  label: 'Delete playlist',
                  danger: true,
                  onSelect: () =>
                    dialogs.confirm({
                      title: `Delete "${playlist.name}"?`,
                      description: 'The songs stay in your library.',
                      confirm: 'Delete',
                      danger: true,
                      onConfirm: async () => {
                        navigate('/library?tab=playlists', { replace: true });
                        await removePlaylist(playlist.id);
                      },
                    }),
                },
              ]}
            />
          </>
        }
      />
      <TrackList
        tracks={tracks}
        playlistId={playlist.id}
        label={`Songs in ${playlist.name}`}
        from={`Playlist · ${playlist.name}`}
        editing={
          editing
            ? {
                onMove: (from, to) => void runAction(() => reorderPlaylist(playlist.id, realIndex(from), realIndex(to))),
                onRemove: (i) => void runAction(() => removeFromPlaylist(playlist.id, realIndex(i))),
              }
            : undefined
        }
        empty={
          <EmptyState
            icon={ListMusic}
            title="Nothing in here yet"
            description="Use the ... menu on any song and pick Add to playlist."
            actions={
              <Button variant="primary" onClick={() => navigate('/library')}>
                Browse your library
              </Button>
            }
          />
        }
      />
    </Page>
  );
}
