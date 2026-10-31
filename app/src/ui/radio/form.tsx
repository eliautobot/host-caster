// Form building blocks for the radio screens (station, host, brains, voices, about me).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Plus } from 'lucide-react';
import { Chip, cx } from '../components';
import './forms.css';

export function FormSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('aw-fsec', className)}>
      <header className="aw-fsec__head">
        <div className="aw-fsec__titles">
          <h2 className="aw-fsec__title">{title}</h2>
          {description && <p className="aw-fsec__desc">{description}</p>}
        </div>
        {action && <div className="aw-fsec__action">{action}</div>}
      </header>
      <div className="aw-fsec__body">{children}</div>
    </section>
  );
}

/** Two columns on desktop, one on phone. */
export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={cx('aw-fgrid', cols === 3 && 'aw-fgrid--3')}>{children}</div>;
}

/** Free-text tags: type and press Enter (or comma); click a chip's x to remove. */
export function TagInput({
  label,
  values,
  onChange,
  placeholder,
  suggestions = [],
  hint,
  max = 12,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  hint?: ReactNode;
  max?: number;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next.slice(0, max));
    setDraft('');
  };
  const open = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 6);
  return (
    <div className="aw-field aw-tags">
      <span className="aw-field__label">{label}</span>
      <div className="aw-control aw-tags__control">
        {values.map((v) => (
          <Chip key={v} size="sm" onRemove={() => onChange(values.filter((x) => x !== v))}>
            {v}
          </Chip>
        ))}
        <input
          className="aw-input aw-tags__input"
          value={draft}
          aria-label={label}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      {open.length > 0 && (
        <div className="aw-tags__suggest">
          {open.map((s) => (
            <Chip key={s} size="sm" icon={Plus} onClick={() => add(s)}>
              {s}
            </Chip>
          ))}
        </div>
      )}
      {hint && <p className="aw-field__hint">{hint}</p>}
    </div>
  );
}

/** Colour swatches (station colours, avatar palettes). */
export function Swatches<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: { value: V; css: string; label: string }[];
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div className="aw-field">
      <span className="aw-field__label">{label}</span>
      <div className="aw-swatches" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-label={o.label}
            title={o.label}
            className="aw-swatch"
            style={{ background: o.css }}
            onClick={() => onChange(o.value)}
          >
            {o.value === value && <Check aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Sticky save bar at the bottom of editors. */
export function SaveBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="aw-savebar">
      <div className="aw-savebar__inner">
        {note && <span className="aw-savebar__note">{note}</span>}
        <div className="aw-savebar__actions">{children}</div>
      </div>
    </div>
  );
}

/** Small status line under a test button. */
export function StatusLine({ tone, children }: { tone: 'ok' | 'error' | 'muted'; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const shown = useRef<string | null>(null);
  // A result (Test, Save) often lands below the fold of a sheet on a phone: bring each new one into view.
  useEffect(() => {
    const text = `${tone}:${ref.current?.textContent ?? ''}`;
    if (text === shown.current) return;
    shown.current = text;
    if (tone !== 'muted') ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  });
  return (
    <p ref={ref} className={cx('aw-statusline', `aw-statusline--${tone}`)}>
      {children}
    </p>
  );
}
