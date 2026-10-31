import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx';
import './Slider.css';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  /** fires on release (seek, save) */
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
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const input = (
    <input
      type="range"
      className={cx('aw-slider', thumb && 'aw-slider--thumb', !showLabel && className)}
      style={{ '--pct': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
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
