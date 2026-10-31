import type { CSSProperties } from 'react';
import { cx } from './cx';
import './Skeleton.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  circle?: boolean;
  className?: string;
}

export function Skeleton({ width = '100%', height = 14, radius, circle, className }: SkeletonProps) {
  const style: CSSProperties = { width, height, borderRadius: circle ? '50%' : radius };
  return <span className={cx('aw-skeleton', className)} style={style} aria-hidden />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cx('aw-skeleton-text', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '62%' : '100%'} height={12} />
      ))}
    </span>
  );
}
