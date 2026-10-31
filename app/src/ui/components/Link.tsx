import type { ComponentProps } from 'react';
import { navigate } from '@/state/router';

export interface LinkProps extends Omit<ComponentProps<'a'>, 'href'> {
  /** app path, e.g. '/hosts/abc' */
  to: string;
  replace?: boolean;
}

/** In-app link; keeps real hrefs so middle-click and "copy link" work. */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={`#${to}`}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
      {...rest}
    />
  );
}
