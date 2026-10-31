import type { ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { cx } from './cx';
import './Chip.css';

export interface ChipProps {
  children: ReactNode;
  icon?: LucideIcon;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function Chip({ children, icon: Icon, selected, onClick, onRemove, size = 'md', className }: ChipProps) {
  const cls = cx('aw-chip', selected && 'aw-chip--selected', size === 'sm' && 'aw-chip--sm', className);
  const body = (
    <>
      {Icon && <Icon aria-hidden />}
      {children}
    </>
  );
  if (onClick && !onRemove) {
    return (
      <button type="button" className={cls} aria-pressed={selected} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls}>
      {body}
      {onRemove && (
        <button type="button" className="aw-chip__remove" aria-label="Remove" onClick={onRemove}>
          <X size={13} aria-hidden />
        </button>
      )}
    </span>
  );
}
