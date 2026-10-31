import type { KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import './Tabs.css';

export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps<V extends string = string> {
  items: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** pills = chips (library filters), segmented = compact switch, underline = page sections */
  variant?: 'pills' | 'segmented' | 'underline';
  label?: string;
  className?: string;
}

export function Tabs<V extends string = string>({
  items,
  value,
  onChange,
  variant = 'pills',
  label,
  className,
}: TabsProps<V>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = items.findIndex((t) => t.value === value);
    const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    if (next) {
      onChange(next.value);
      (e.currentTarget.querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
    }
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('aw-tabs', variant !== 'pills' && `aw-tabs--${variant}`, className)}
      onKeyDown={onKey}
    >
      {items.map(({ value: v, label: l, icon: Icon }) => (
        <button
          key={v}
          type="button"
          role="tab"
          data-value={v}
          aria-selected={v === value}
          tabIndex={v === value ? 0 : -1}
          className="aw-tab"
          onClick={() => onChange(v)}
        >
          {Icon && <Icon aria-hidden />}
          {l}
        </button>
      ))}
    </div>
  );
}
