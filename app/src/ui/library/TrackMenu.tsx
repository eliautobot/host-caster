// The "..." menu of a song: queue, playlists, like, go to album/artist, remove, delete.
import { useRef, useState } from 'react';
import { Disc3, Ellipsis, Heart, HeartOff, ListEnd, ListPlus, ListStart, ListX, Trash2, UserRound } from 'lucide-react';
import { albumIdOf, artistIdOf, deleteTracks, removeFromPlaylist, toggleLike } from '@/core/library';
import type { Track } from '@/core/types';
import { navigate } from '@/state/router';
import { runAction } from '../actions';
import { Artwork, IconButton } from '../components';
import { ActionMenu, type MenuItem } from './ActionMenu';
import { dialogs } from './dialogs';
import { addToQueue, playNext } from './play';

export interface TrackMenuContext {
  /** shown inside this playlist: offer "Remove from this playlist" */
  playlistId?: string;
  playlistIndex?: number;
  /** shown in the queue */
  onRemoveFromQueue?: () => void;
}

export function trackMenuItems(track: Track, ctx: TrackMenuContext = {}): MenuItem[] {
  const stream = track.source === 'stream';
  return [
    { icon: ListStart, label: 'Play next', onSelect: () => void playNext([track]), hidden: Boolean(ctx.onRemoveFromQueue) },
    { icon: ListEnd, label: 'Add to queue', onSelect: () => void addToQueue([track]), hidden: Boolean(ctx.onRemoveFromQueue) },
    { icon: ListPlus, label: 'Add to playlist', onSelect: () => dialogs.addToPlaylist([track]) },
    {
      icon: track.liked ? HeartOff : Heart,
      label: track.liked ? 'Remove from Liked songs' : 'Add to Liked songs',
      onSelect: () => void runAction(() => toggleLike(track)),
    },
    { icon: Disc3, label: 'Go to album', onSelect: () => navigate(`/library/albums/${albumIdOf(track)}`), hidden: stream },
    { icon: UserRound, label: 'Go to artist', onSelect: () => navigate(`/library/artists/${artistIdOf(track.artist)}`), hidden: stream },
    {
      icon: ListX,
      label: 'Remove from this playlist',
      hidden: ctx.playlistId === undefined || ctx.playlistIndex === undefined,
      onSelect: () => void runAction(() => removeFromPlaylist(ctx.playlistId!, ctx.playlistIndex!)),
    },
    { icon: ListX, label: 'Remove from queue', hidden: !ctx.onRemoveFromQueue, onSelect: () => ctx.onRemoveFromQueue?.() },
    {
      icon: Trash2,
      label: track.source === 'local' ? 'Delete from this device' : 'Remove from library',
      danger: true,
      onSelect: () => confirmDelete([track]),
    },
  ];
}

export function confirmDelete(tracks: Track[]) {
  const one = tracks.length === 1;
  const local = tracks.some((t) => t.source === 'local');
  dialogs.confirm({
    title: one ? `Delete "${tracks[0]!.title}"?` : `Delete ${tracks.length} songs?`,
    description: local
      ? 'The audio file is removed from this device and from every playlist. This cannot be undone.'
      : 'It is removed from your library and playlists.',
    confirm: 'Delete',
    danger: true,
    onConfirm: () => deleteTracks(tracks.map((t) => t.id)),
  });
}

export function TrackMenuButton({ track, ctx, size = 'sm' }: { track: Track; ctx?: TrackMenuContext; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={btn}
        icon={Ellipsis}
        label={`More for ${track.title}`}
        size={size}
        className="aw-track__more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      />
      <ActionMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={btn.current}
        items={trackMenuItems(track, ctx)}
        label={`Actions for ${track.title}`}
        header={
          <div className="aw-menu-track">
            <Artwork artworkId={track.artworkId} size={48} radius={8} />
            <div className="aw-menu-track__text">
              <p className="aw-truncate aw-menu-track__title">{track.title}</p>
              <p className="aw-truncate aw-muted">{track.artist}</p>
            </div>
          </div>
        }
      />
    </>
  );
}
