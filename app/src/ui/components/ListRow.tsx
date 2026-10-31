import type { ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { navigate } from '@/state/router';
import { cx } from './cx';
import './ListRow.css';

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** an icon (shown in a rounded tile) or any node (Avatar, Artwork) */
  leading?: LucideIcon | ReactNode;
  trailing?: ReactNode;
  /** route path; renders a link */
  to?: string;
  onClick?: () => void;
  chevron?: boolean;
  active?: boolean;
  className?: string;
}

function isIcon(x: unknown): x is LucideIcon {
  return typeof x === 'function' || (typeof x === 'object' && x !== null && '$$typeof' in x && 'render' in x);
}

export function ListRow({ title, subtitle, leading, trailing, to, onClick, chevron, active, className }: ListRowProps) {
  const LeadIcon = isIcon(leading) ? leading : undefined;
  const content = (
    <>
      {leading && (
        <span className="aw-row__leading">
          {LeadIcon ? (
            <span className="aw-row__icon">
              <LeadIcon aria-hidden />
            </span>
          ) : (
            (leading as ReactNode)
          )}
        </span>
      )}
      <span className="aw-row__text">
        <span className="aw-row__title">{title}</span>
        {subtitle && <span className="aw-row__subtitle">{subtitle}</span>}
      </span>
      {(trailing || chevron) && (
        <span className="aw-row__trailing">
          {trailing}
          {chevron && <ChevronRight className="aw-row__chevron" aria-hidden />}
        </span>
      )}
    </>
  );
  const cls = cx('aw-row', active && 'aw-row--active', className);
  if (to) {
    return (
      <a
        href={`#${to}`}
        className={cls}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          onClick?.();
          navigate(to);
        }}
      >
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={cls}>{content}</div>;
}

/** Vertical list wrapper; `card` puts it on a card background. */
export function List({ children, card, className }: { children: ReactNode; card?: boolean; className?: string }) {
  return <div className={cx('aw-list', card && 'aw-list--card', className)}>{children}</div>;
}
