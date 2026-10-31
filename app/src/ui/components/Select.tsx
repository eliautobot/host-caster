import { useId, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { FieldFrame } from './TextField';
import { cx } from './cx';
import './Field.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<ComponentProps<'select'>, 'onChange' | 'value'> {
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** Native select (best on phones), styled to match TextField. */
export function Select<V extends string = string>({
  value,
  options,
  onChange,
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: SelectProps<V>) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <FieldFrame label={label} hint={hint} error={error} id={fid} className={className}>
      <div className={cx('aw-control', error && 'aw-control--invalid')}>
        <select
          id={fid}
          className="aw-select"
          value={value}
          onChange={(e) => onChange(e.target.value as V)}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="aw-control__chevron" aria-hidden />
      </div>
    </FieldFrame>
  );
}
