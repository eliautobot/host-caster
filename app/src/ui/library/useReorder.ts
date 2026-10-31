// Drag to reorder with pointer events (mouse and touch) on a handle, plus Alt+Arrow keys on the handle.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

interface Drag {
  from: number;
  to: number;
  dy: number;
  h: number;
}

export function useReorder(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag>();
  const cur = useRef<Drag | undefined>(undefined);

  const update = (d: Drag | undefined) => {
    cur.current = d;
    setDrag(d);
  };

  const handleProps = (index: number) => ({
    style: { touchAction: 'none', cursor: 'grab' } as CSSProperties,
    'aria-label': 'Drag to reorder (Alt+Up / Alt+Down)',
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const row = handle.closest<HTMLElement>('[data-row]');
      if (!row) return;
      const next = row.nextElementSibling as HTMLElement | null;
      const h = next ? next.getBoundingClientRect().top - row.getBoundingClientRect().top : row.getBoundingClientRect().height;
      const startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
      update({ from: index, to: index, dy: 0, h: h || 56 });
      const move = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - startY;
        const to = Math.max(0, Math.min(count - 1, index + Math.round(dy / (h || 56))));
        update({ from: index, to, dy, h: h || 56 });
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        const d = cur.current;
        update(undefined);
        if (d && d.to !== d.from) onMove(d.from, d.to);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const to = index + (e.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < count) onMove(index, to);
    },
  });

  const rowStyle = (index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (index === drag.from) {
      return { transform: `translateY(${drag.dy}px)`, zIndex: 2, position: 'relative', transition: 'none' };
    }
    if (drag.from < index && index <= drag.to) return { transform: `translateY(${-drag.h}px)` };
    if (drag.to <= index && index < drag.from) return { transform: `translateY(${drag.h}px)` };
    return undefined;
  };

  return { dragging: drag !== undefined, draggingIndex: drag?.from, handleProps, rowStyle };
}
