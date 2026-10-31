import { useEffect, useState, type CSSProperties } from 'react';
import { Music2, type LucideIcon } from 'lucide-react';
import { artworkUrl } from '@/core/services';
import { cx } from './cx';
import './Artwork.css';

export interface ArtworkProps {
  /** blobs.id */
  artworkId?: string;
  /** direct URL (server art, remote covers) */
  src?: string;
  size?: number;
  /** fills its container (square) */
  fluid?: boolean;
  radius?: number;
  icon?: LucideIcon;
  alt?: string;
  className?: string;
}

/** Track or playlist cover with a neutral placeholder. */
export function Artwork({ artworkId, src, size = 48, fluid, radius, icon: Icon = Music2, alt = '', className }: ArtworkProps) {
  const [blobUrl, setBlobUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    if (artworkId) void artworkUrl(artworkId).then((u) => live && setBlobUrl(u));
    else setBlobUrl(undefined);
    return () => {
      live = false;
    };
  }, [artworkId]);
  const url = src ?? blobUrl;
  const style = { '--size': `${size}px`, '--art-radius': radius ? `${radius}px` : undefined } as CSSProperties;
  return (
    <span className={cx('aw-art', fluid && 'aw-art--fluid', className)} style={style}>
      {url ? <img src={url} alt={alt} loading="lazy" /> : <Icon aria-hidden />}
    </span>
  );
}

export interface StationArtProps {
  color: string;
  frequency: string;
  size?: number;
  fluid?: boolean;
  radius?: number;
  className?: string;
}

/** Station tile: colour wash with the frequency. */
export function StationArt({ color, frequency, size = 48, fluid, radius, className }: StationArtProps) {
  const style = {
    '--size': `${size}px`,
    '--c': color,
    '--art-radius': radius ? `${radius}px` : undefined,
    containerType: fluid ? 'inline-size' : undefined,
  } as CSSProperties;
  return (
    <span className={cx('aw-station-art', fluid && 'aw-station-art--fluid', className)} style={style} aria-hidden>
      <svg className="aw-station-art__waves" viewBox="0 0 100 100" fill="none" stroke="#fff" strokeWidth="7">
        <circle cx="100" cy="100" r="30" />
        <circle cx="100" cy="100" r="58" />
        <circle cx="100" cy="100" r="86" />
      </svg>
      {size >= 36 || fluid ? <span className="aw-station-art__freq">{frequency}</span> : null}
    </span>
  );
}
