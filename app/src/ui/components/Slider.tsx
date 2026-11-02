import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from './cx';
import { SliderGesture, type GestureOptions } from './sliderGesture';
import './Slider.css';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  /** fires once when the user is done (seek, save): on release, after a tap, a key, or when the gesture is lost */
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** accessible name; with `showLabel` also shown above the track */
  label: string;
  showLabel?: boolean;
  /** formats the value shown next to the label */
  format?: (value: number) => ReactNode;
  /** always show the thumb (settings); default shows it on hover (player) */
  thumb?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  showLabel,
  format,
  thumb,
  disabled,
  className,
}: SliderProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const opts = useRef<GestureOptions>(undefined as never);
  opts.current = {
    min,
    max,
    step,
    onChange,
    onCommit,
    disabled,
    rect: () => ref.current?.getBoundingClientRect() ?? { left: 0, width: 1 },
    onActive: setActive,
  };
  const g = useRef<SliderGesture>(undefined as never);
  g.current ??= new SliderGesture(() => opts.current);

  useEffect(() => {
    const el = ref.current;
    const gesture = g.current;
    if (!el) return;
    // native listeners: React's onChange is the input event, and its touch listeners are passive
    const change = () => gesture.change(Number(el.value));
    const move = (e: TouchEvent) => gesture.dragging && e.cancelable && e.preventDefault();
    const end = (e: TouchEvent) => gesture.owning && e.cancelable && e.preventDefault();
    el.addEventListener('change', change);
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: false });
    return () => {
      el.removeEventListener('change', change);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      gesture.dispose();
    };
  }, []);

  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const input = (
    <input
      ref={ref}
      type="range"
      className={cx('aw-slider', thumb && 'aw-slider--thumb', active && 'aw-slider--active', !showLabel && className)}
      style={{ '--pct': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => g.current.input(Number(e.target.value))}
      onPointerDown={(e) => {
        g.current.pointerDown(e);
        const el = e.currentTarget;
        if (g.current.owning) el.setPointerCapture?.(e.pointerId);
        // the up may land outside the slider (mouse) or never reach it
        const up = (u: PointerEvent) => g.current.pointerUp(u);
        const cancel = (u: PointerEvent) => g.current.pointerCancel(u);
        const off = () => {
          window.removeEventListener('pointerup', up, true);
          window.removeEventListener('pointercancel', cancel, true);
        };
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', cancel, true);
        window.addEventListener('pointerup', off, { once: true });
        window.addEventListener('pointercancel', off, { once: true });
      }}
      onPointerMove={(e) => g.current.pointerMove(e)}
      onPointerUp={(e) => g.current.pointerUp(e)}
      onPointerCancel={(e) => g.current.pointerCancel(e)}
      onLostPointerCapture={(e) => g.current.pointerCancel(e)}
      onKeyUp={() => g.current.keyUp()}
      onBlur={() => g.current.blur()}
      onContextMenu={(e) => g.current.owning && e.preventDefault()}
    />
  );
  if (!showLabel) return input;
  return (
    <div className={cx('aw-slider-field', className)}>
      <div className="aw-slider-field__top">
        <span className="aw-slider-field__label">{label}</span>
        <span className="aw-slider-field__value">{format ? format(value) : value}</span>
      </div>
      {input}
    </div>
  );
}
