import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent font-semibold text-on-accent hover:bg-accent-hover',
  secondary:
    'border border-edge bg-surface-raised font-medium text-fg-muted hover:bg-surface-overlay hover:text-fg-body',
  ghost: 'font-medium text-fg-muted hover:bg-surface-overlay hover:text-fg-body',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-xs',
};

// Coarse pointers get a 44px min touch target without changing the resting
// desktop height (the touch enlargement the WorkDrawer used to repeat by hand).
const BASE_CLASS =
  'inline-flex shrink-0 items-center justify-center gap-1 rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-default [@media(pointer:coarse)]:min-h-11';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * The shared solid/secondary/ghost button. Honors the house aria-disabled
 * click-guard: an `aria-disabled` button stays focusable and in the tab order,
 * styles itself via `aria-disabled:` utilities, and swallows its own click so
 * callers don't each re-implement the `preventDefault(); return;` guard.
 * `type` defaults to "button" so a Button inside a form never submits by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type, className, onClick, children, ...props },
  ref,
) {
  const ariaDisabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={`${BASE_CLASS} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className ?? ''}`}
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
