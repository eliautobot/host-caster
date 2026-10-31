import type { ReactNode } from 'react';
import { cx } from './cx';
import './SectionHeader.css';

export interface SectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  /** right side: a ghost Button ("Show all") etc. */
  action?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}

export function SectionHeader({ title, subtitle, eyebrow, action, as: H = 'h2', className }: SectionHeaderProps) {
  return (
    <div className={cx('aw-section-header', className)}>
      <div className="aw-section-header__text">
        {eyebrow && <p className="aw-section-header__eyebrow">{eyebrow}</p>}
        <H className="aw-section-header__title">{title}</H>
        {subtitle && <p className="aw-section-header__subtitle">{subtitle}</p>}
      </div>
      {action && <div className="aw-section-header__action">{action}</div>}
    </div>
  );
}
