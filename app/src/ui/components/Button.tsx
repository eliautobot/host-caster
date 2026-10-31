import type { ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger' | 'icon';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  block?: boolean;
}

/** Pill button. variant 'icon' = round icon-only secondary button (pass aria-label). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isIcon = variant === 'icon';
  return (
    <button
      type={type}
      className={cx(
        'aw-btn',
        `aw-btn--${isIcon ? 'secondary' : variant}`,
        isIcon && 'aw-btn--icon',
        size !== 'md' && `aw-btn--${size}`,
        block && 'aw-btn--block',
        loading && 'aw-btn--loading',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {Icon && <Icon aria-hidden />}
      {children !== undefined && !isIcon && <span className="aw-btn__label">{children}</span>}
      {IconRight && <IconRight aria-hidden />}
      {loading && <span className="aw-spinner" aria-hidden />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: LucideIcon;
  /** accessible name; also the tooltip */
  label: string;
  variant?: 'ghost' | 'solid' | 'primary' | 'accent';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** highlighted (e.g. shuffle on) */
  active?: boolean;
  iconProps?: { fill?: string; strokeWidth?: number };
}

export function IconButton({
  icon: Icon,
  label,
  variant = 'ghost',
  size = 'md',
  active,
  className,
  type = 'button',
  iconProps,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'aw-iconbtn',
        variant !== 'ghost' && `aw-iconbtn--${variant}`,
        size !== 'md' && `aw-iconbtn--${size}`,
        active && 'aw-iconbtn--active',
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden {...iconProps} />
    </button>
  );
}
