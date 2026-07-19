import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonVariant = 'ghost' | 'bordered' | 'primary';
export type IconButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  ghost: 'text-fg-muted hover:bg-surface-overlay hover:text-fg',
  bordered: 'border border-edge bg-surface-raised text-fg-muted hover:bg-surface-overlay hover:text-fg-body',
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
};

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: 'size-6',
  md: 'size-7',
};

// Square, icon-only. Coarse pointers grow to a 44px touch target — the verbatim
// 40-token enlargement string the WorkDrawer/dock used to repeat is now here.
const BASE_CLASS =
  'grid shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-default [@media(pointer:coarse)]:size-11';

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Required — an icon-only control has no visible text to name it. */
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** The icon element. */
  children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', type, className, onClick, children, ...props },
  ref,
) {
  const ariaDisabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={`${BASE_CLASS} ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${className ?? ''}`}
      onClick={(event) => {
        if (ariaDisabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
