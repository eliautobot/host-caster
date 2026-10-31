import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { usePresence } from '../hooks/usePresence';
import { IconButton } from './Button';
import { cx } from './cx';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** desktop dialog width; 'full' = full screen on every size (Now Playing) */
  size?: 'sm' | 'md' | 'lg' | 'full';
  /** hide the default header (custom layouts) */
  bare?: boolean;
  className?: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Bottom sheet on phone, centered dialog on desktop. */
export function Sheet({ open, onClose, title, description, children, footer, size = 'md', bare, className }: SheetProps) {
  const { mounted, visible } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
      el?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div className="aw-sheet-root" data-state={visible ? 'open' : 'closed'}>
      <div className="aw-sheet-scrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx('aw-sheet', `aw-sheet--${size}`, className)}
      >
        {size !== 'full' && <div className="aw-sheet__handle" aria-hidden />}
        {!bare && (
          <header className="aw-sheet__header">
            <div className="aw-sheet__titles">
              {title && (
                <h2 id={titleId} className="aw-sheet__title">
                  {title}
                </h2>
              )}
              {description && <p className="aw-sheet__desc">{description}</p>}
            </div>
            <IconButton icon={X} label="Close" size="sm" variant="solid" onClick={onClose} />
          </header>
        )}
        <div className="aw-sheet__body">{children}</div>
        {footer && <footer className="aw-sheet__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
