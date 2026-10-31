import { useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import './Field.css';

interface FieldFrameProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id: string;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error. Shared by TextField, TextArea and Select. */
export function FieldFrame({ label, hint, error, id, className, children }: FieldFrameProps) {
  return (
    <div className={cx('aw-field', className)}>
      {label && (
        <label className="aw-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="aw-field__error" id={`${id}-msg`}>
          {error}
        </p>
      ) : hint ? (
        <p className="aw-field__hint" id={`${id}-msg`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'onChange'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: LucideIcon;
  trailing?: ReactNode;
  onChange?: (value: string) => void;
}

export function TextField({ label, hint, error, icon: Icon, trailing, onChange, className, id, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <FieldFrame label={label} hint={hint} error={error} id={fid} className={className}>
      <div className={cx('aw-control', error && 'aw-control--invalid')}>
        {Icon && (
          <span className="aw-control__icon">
            <Icon aria-hidden />
          </span>
        )}
        <input
          id={fid}
          className="aw-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${fid}-msg` : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          {...rest}
        />
        {trailing && <span className="aw-control__trailing">{trailing}</span>}
      </div>
    </FieldFrame>
  );
}

export interface TextAreaProps extends Omit<ComponentProps<'textarea'>, 'onChange'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** grow with the content */
  autoResize?: boolean;
  onChange?: (value: string) => void;
}

export function TextArea({ label, hint, error, autoResize, onChange, className, id, value, ...rest }: TextAreaProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoResize || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [autoResize, value]);
  return (
    <FieldFrame label={label} hint={hint} error={error} id={fid} className={className}>
      <div className={cx('aw-control', error && 'aw-control--invalid')}>
        <textarea
          ref={ref}
          id={fid}
          value={value}
          className={cx('aw-textarea', autoResize && 'aw-textarea--auto')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${fid}-msg` : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          {...rest}
        />
      </div>
    </FieldFrame>
  );
}
