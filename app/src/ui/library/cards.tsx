// Grid tiles: albums, artists, playlists, Liked songs, "new" tiles.
import type { ReactNode } from 'react';
import { Play, UserRound, type LucideIcon } from 'lucide-react';
import type { Album, Artist } from '@/core/library';
import type { Playlist, Track } from '@/core/types';
import { navigate } from '@/state/router';
import { Artwork, cx } from '../components';
import { LikedCover, PlaylistCover } from './covers';
import { playTracks } from './play';

function Tile({
  to,
  cover,
  title,
  meta,
  round,
  onPlay,
  label,
}: {
  to: string;
  cover: ReactNode;
  title: string;
  meta?: ReactNode;
  round?: boolean;
  onPlay?: () => void;
  label: string;
}) {
  return (
    <div className={cx('aw-tile', round && 'aw-tile--round')}>
      <span className="aw-tile__cover">
        {cover}
        {onPlay && (
          <button type="button" className="aw-tile__play" aria-label={`Play ${title}`} onClick={onPlay}>
            <Play fill="currentColor" strokeWidth={0} aria-hidden />
          </button>
        )}
      </span>
      <a
        href={`#${to}`}
        className="aw-tile__link aw-tile__title aw-truncate"
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          navigate(to);
        }}
      >
        {title}
      </a>
      {meta && <span className="aw-tile__meta aw-truncate">{meta}</span>}
    </div>
  );
}

export function AlbumCard({ album }: { album: Album }) {
  return (
    <Tile
      to={`/library/albums/${album.id}`}
      label={`Album ${album.title} by ${album.artist}`}
      cover={<Artwork artworkId={album.artworkId} fluid radius={12} />}
      title={album.title}
      meta={album.year ? `${album.artist} · ${album.year}` : album.artist}
      onPlay={() => void playTracks(album.tracks, 0, { shuffle: false })}
    />
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  return (
    <Tile
      round
      to={`/library/artists/${artist.id}`}
      label={`Artist ${artist.name}`}
      cover={<Artwork artworkId={artist.artworkId} fluid radius={999} icon={UserRound} />}
      title={artist.name}
      meta={`${artist.tracks.length} song${artist.tracks.length === 1 ? '' : 's'}`}
      onPlay={() => void playTracks(artist.tracks, 0, { shuffle: true })}
    />
  );
}

export function PlaylistCard({ playlist, tracks }: { playlist: Playlist; tracks: () => Track[] }) {
  return (
    <Tile
      to={`/library/playlists/${playlist.id}`}
      label={`Playlist ${playlist.name}`}
      cover={<PlaylistCover playlist={playlist} fluid radius={12} />}
      title={playlist.name}
      meta={`Playlist · ${playlist.trackIds.length} song${playlist.trackIds.length === 1 ? '' : 's'}`}
      onPlay={playlist.trackIds.length ? () => void playTracks(tracks(), 0, { shuffle: false }) : undefined}
    />
  );
}

export function LikedCard({ tracks }: { tracks: Track[] }) {
  return (
    <Tile
      to="/library/liked"
      label="Liked songs"
      cover={<LikedCover fluid radius={12} />}
      title="Liked songs"
      meta={`${tracks.length} song${tracks.length === 1 ? '' : 's'}`}
      onPlay={tracks.length ? () => void playTracks(tracks, 0, { shuffle: false }) : undefined}
    />
  );
}

export function NewTile({ icon: Icon, title, desc, onClick }: { icon: LucideIcon; title: string; desc: string; onClick: () => void }) {
  return (
    <button type="button" className="aw-tile aw-tile--new" onClick={onClick}>
      <span className="aw-tile__cover aw-tile__newcover">
        <span className="aw-tile__newicon">
          <Icon aria-hidden />
        </span>
      </span>
      <span className="aw-tile__title">{title}</span>
      <span className="aw-tile__meta">{desc}</span>
    </button>
  );
}
