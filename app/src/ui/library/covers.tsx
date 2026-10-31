// Playlist covers: the playlist's own cover, else a 2x2 mosaic of its first covers. Liked songs get a warm heart tile.
import type { CSSProperties } from 'react';
import { Heart, ListMusic } from 'lucide-react';
import type { Playlist } from '@/core/types';
import { useLibrary } from '@/state/library';
import { Artwork, cx } from '../components';

export function PlaylistCover({ playlist, size = 48, fluid, radius }: { playlist: Playlist; size?: number; fluid?: boolean; radius?: number }) {
  const tracks = useLibrary((s) => s.tracks);
  if (playlist.coverId) return <Artwork artworkId={playlist.coverId} size={size} fluid={fluid} radius={radius} icon={ListMusic} />;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const arts: string[] = [];
  for (const id of playlist.trackIds) {
    const a = byId.get(id)?.artworkId;
    if (a && !arts.includes(a)) arts.push(a);
    if (arts.length === 4) break;
  }
  if (arts.length < 4) return <Artwork artworkId={arts[0]} size={size} fluid={fluid} radius={radius} icon={ListMusic} />;
  const style = { '--size': `${size}px`, '--art-radius': radius ? `${radius}px` : undefined } as CSSProperties;
  return (
    <span className={cx('aw-mosaic', fluid && 'aw-mosaic--fluid')} style={style}>
      {arts.map((a) => (
        <Artwork key={a} artworkId={a} fluid radius={1} />
      ))}
    </span>
  );
}

export function LikedCover({ size = 48, fluid, radius }: { size?: number; fluid?: boolean; radius?: number }) {
  const style = { '--size': `${size}px`, '--art-radius': radius ? `${radius}px` : undefined } as CSSProperties;
  return (
    <span className={cx('aw-liked-cover', fluid && 'aw-liked-cover--fluid')} style={style} aria-hidden>
      <Heart fill="currentColor" strokeWidth={0} />
    </span>
  );
}
