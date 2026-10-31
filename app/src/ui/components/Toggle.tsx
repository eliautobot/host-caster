import { useId, type ReactNode } from 'react';
import { cx } from './cx';
import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** with a label the toggle renders as a full row */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
}

export function Toggle({ checked, onChange, label, description, disabled, size = 'md', className, ...aria }: ToggleProps) {
  const id = useId();
  const sw = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label ? undefined : aria['aria-label']}
      aria-labelledby={label ? `${id}-l` : undefined}
      disabled={disabled}
      className={cx('aw-toggle', size === 'sm' && 'aw-toggle--sm', !label && className)}
      onClick={() => onChange(!checked)}
    />
  );
  if (!label) return sw;
  return (
    <label className={cx('aw-toggle-row', className)} htmlFor={id}>
      <span className="aw-toggle-row__text">
        <span className="aw-toggle-row__label" id={`${id}-l`}>
          {label}
        </span>
        {description && <span className="aw-toggle-row__desc">{description}</span>}
      </span>
      {sw}
    </label>
  );
}
