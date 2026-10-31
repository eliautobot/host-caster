// Action menu: a popover next to its button on desktop, a bottom sheet on phones.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { Sheet, cx } from '../components';
import { useIsDesktop } from '../hooks/useMediaQuery';
import './library.css';

export interface MenuItem {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export interface ActionMenuProps {
  open: boolean;
  onClose: () => void;
  /** the button that opened it (desktop popover position) */
  anchor?: HTMLElement | null;
  items: MenuItem[];
  /** phone sheet header (e.g. the song with its cover) */
  header?: ReactNode;
  label?: string;
}

export function ActionMenu({ open, onClose, anchor, items, header, label = 'Actions' }: ActionMenuProps) {
  const desktop = useIsDesktop();
  const visible = items.filter((i) => !i.hidden);
  const pick = (i: MenuItem) => {
    onClose();
    // let the menu close before a sheet opens from the action
    setTimeout(i.onSelect, 0);
  };
  if (!desktop) {
    return (
      <Sheet open={open} onClose={onClose} bare size="sm">
        {header && <div className="aw-menu-sheet__header">{header}</div>}
        <div className="aw-menu-sheet" role="menu" aria-label={label}>
          {visible.map((i) => (
            <button key={i.label} type="button" role="menuitem" className={cx('aw-menu__item', i.danger && 'is-danger')} onClick={() => pick(i)}>
              <i.icon aria-hidden />
              {i.label}
            </button>
          ))}
        </div>
      </Sheet>
    );
  }
  return open ? <Popover anchor={anchor} onClose={onClose} items={visible} pick={pick} label={label} /> : null;
}

function Popover({
  anchor,
  onClose,
  items,
  pick,
  label,
}: {
  anchor?: HTMLElement | null;
  onClose: () => void;
  items: MenuItem[];
  pick: (i: MenuItem) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    const el = ref.current;
    const r = anchor?.getBoundingClientRect();
    if (!el || !r) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight - 8;
    setPos({
      top: below ? r.bottom + 6 : Math.max(8, r.top - h - 6),
      left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)),
    });
    el.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }
    };
    const onScroll = () => onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="aw-menu"
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {items.map((i) => (
        <button key={i.label} type="button" role="menuitem" className={cx('aw-menu__item', i.danger && 'is-danger')} onClick={() => pick(i)}>
          <i.icon aria-hidden />
          {i.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
