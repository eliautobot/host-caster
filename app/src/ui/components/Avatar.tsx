import type { CSSProperties } from 'react';
import type { HostAvatar } from '@/core/types';
import { paletteColors, paletteFor } from './avatarPalettes';
import { cx } from './cx';
import './Avatar.css';

export interface AvatarProps {
  avatar?: HostAvatar;
  /** used for the monogram fallback and alt text */
  name: string;
  size?: number;
  shape?: 'circle' | 'square';
  /** pulsing on-air ring while this host talks */
  speaking?: boolean;
  /** resolved URL for kind 'image' when value is a blob id */
  imageUrl?: string;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : parts[0]!.slice(0, 1)).toUpperCase();
}

export function Avatar({ avatar, name, size = 40, shape = 'circle', speaking, imageUrl, className }: AvatarProps) {
  const kind = avatar?.kind ?? 'monogram';
  const [from, to] = paletteColors(avatar?.color ?? paletteFor(name));
  const style = { '--size': `${size}px`, '--from': from, '--to': to } as CSSProperties;
  const cls = cx(
    'aw-avatar',
    `aw-avatar--${kind}`,
    shape === 'square' && 'aw-avatar--square',
    speaking && 'aw-avatar--speaking',
    className,
  );
  if (kind === 'image') {
    return (
      <span className={cls} style={style}>
        <img src={imageUrl ?? avatar?.value} alt={name} loading="lazy" />
      </span>
    );
  }
  const label = kind === 'emoji' ? avatar?.value : avatar?.value || initials(name);
  return (
    <span className={cls} style={style} role="img" aria-label={name}>
      <span aria-hidden>{label}</span>
    </span>
  );
}

export interface AvatarStackProps {
  people: { id: string; name: string; avatar?: HostAvatar }[];
  size?: number;
  max?: number;
  speakingId?: string;
  className?: string;
}

/** Overlapping avatars (a station's line-up). */
export function AvatarStack({ people, size = 28, max = 4, speakingId, className }: AvatarStackProps) {
  return (
    <span className={cx('aw-avatar-stack', className)} style={{ '--size': `${size}px` } as CSSProperties}>
      {people.slice(0, max).map((p) => (
        <Avatar key={p.id} avatar={p.avatar} name={p.name} size={size} speaking={p.id === speakingId} />
      ))}
    </span>
  );
}
