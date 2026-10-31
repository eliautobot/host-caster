import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import './EmptyState.css';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** buttons */
  actions?: ReactNode;
  size?: 'normal' | 'compact';
  /** sits on a card background */
  card?: boolean;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, actions, size = 'normal', card, className }: EmptyStateProps) {
  return (
    <div className={cx('aw-empty', size === 'compact' && 'aw-empty--compact', card && 'aw-empty--card', className)}>
      <div className="aw-empty__icon" aria-hidden>
        <Icon />
      </div>
      <h2 className="aw-empty__title">{title}</h2>
      {description && <p className="aw-empty__desc">{description}</p>}
      {actions && <div className="aw-empty__actions">{actions}</div>}
    </div>
  );
}
