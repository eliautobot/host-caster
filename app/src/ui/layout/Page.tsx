import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { back } from '@/state/router';
import { IconButton } from '../components/Button';
import { cx } from '../components/cx';
import './Page.css';

export interface PageProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** small line above the title */
  eyebrow?: ReactNode;
  /** header buttons (right side) */
  actions?: ReactNode;
  /** shows a back button; the value is the fallback path for deep links */
  back?: string;
  /** colour wash behind the header (station colour etc.) */
  tint?: string;
  /** 'narrow' for forms and settings */
  width?: 'normal' | 'narrow' | 'full';
  children?: ReactNode;
  className?: string;
}

/** Standard screen frame: header + content column. Every screen should render inside one. */
export function Page({ title, subtitle, eyebrow, actions, back: backTo, tint, width = 'normal', children, className }: PageProps) {
  return (
    <div className={cx('aw-page', `aw-page--${width}`, className)} style={tint ? ({ '--tint': tint } as CSSProperties) : undefined}>
      {tint && <div className="aw-page__tint" aria-hidden />}
      {(title || backTo || actions) && (
        <header className={cx('aw-page__header', backTo !== undefined && 'aw-page__header--back')}>
          {backTo !== undefined && (
            <IconButton
              icon={ChevronLeft}
              label="Back"
              variant="solid"
              className="aw-page__back"
              onClick={() => back(backTo)}
            />
          )}
          <div className="aw-page__titles">
            {eyebrow && <p className="aw-page__eyebrow">{eyebrow}</p>}
            {title && <h1 className="aw-page__title">{title}</h1>}
          </div>
          {actions && <div className="aw-page__actions">{actions}</div>}
          {subtitle && <p className="aw-page__subtitle">{subtitle}</p>}
        </header>
      )}
      <div className="aw-page__body">{children}</div>
    </div>
  );
}
