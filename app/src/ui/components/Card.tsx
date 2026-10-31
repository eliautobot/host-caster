import type { ComponentProps, ElementType, ReactNode } from 'react';
import { cx } from './cx';
import './Card.css';

export interface CardProps extends Omit<ComponentProps<'div'>, 'onClick'> {
  variant?: 'plain' | 'outline' | 'raised';
  padding?: 'normal' | 'compact' | 'flush';
  /** renders a <button> with hover state */
  onClick?: () => void;
  as?: ElementType;
  children?: ReactNode;
}

export function Card({ variant = 'plain', padding = 'normal', onClick, as, className, children, ...rest }: CardProps) {
  const Tag: ElementType = as ?? (onClick ? 'button' : 'div');
  return (
    <Tag
      className={cx(
        'aw-card',
        variant !== 'plain' && `aw-card--${variant}`,
        padding !== 'normal' && `aw-card--${padding}`,
        onClick && 'aw-card--interactive',
        className,
      )}
      onClick={onClick}
      {...(Tag === 'button' ? { type: 'button' } : {})}
      {...rest}
    >
      {children}
    </Tag>
  );
}
