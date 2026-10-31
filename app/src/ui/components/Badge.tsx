import type { ReactNode } from 'react';
import { cx } from './cx';
import './Badge.css';

export interface BadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warm' | 'ok' | 'danger' | 'solid';
  /** leading dot; 'live' pulses */
  dot?: boolean | 'live';
  size?: 'md' | 'lg';
  className?: string;
}

export function Badge({ children, tone = 'neutral', dot, size = 'md', className }: BadgeProps) {
  return (
    <span className={cx('aw-badge', tone !== 'neutral' && `aw-badge--${tone}`, size === 'lg' && 'aw-badge--lg', className)}>
      {dot && <span className={cx('aw-badge__dot', dot === 'live' && 'aw-badge__dot--live')} aria-hidden />}
      {children}
    </span>
  );
}

/** Pulsing ON AIR badge; quiet OFF AIR when the station is not live. */
export function OnAirBadge({ onAir, size, className }: { onAir: boolean; size?: 'md' | 'lg'; className?: string }) {
  return onAir ? (
    <Badge tone="solid" dot="live" size={size} className={className}>
      On air
    </Badge>
  ) : (
    <Badge dot size={size} className={className}>
      Off air
    </Badge>
  );
}
