import type { ReactNode } from 'react';
import { Tooltip } from '../a11y';

export type SegmentedControlItem<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** When set, the item is wrapped in an a11y Tooltip; the disabled case can
   * pass a "why it's disabled" hint. */
  tooltip?: string;
};

/**
 * The shared segmented control: one `role="group"` of `aria-pressed` buttons on
 * the shell/item recipe distilled from the former layout toggle. Used by the
 * dock's Mine/All filter and the attention filter tabs.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  items,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  items: SegmentedControlItem<T>[];
  className?: string;
  'aria-label': string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a compact segmented control already exposes a named group and pressed buttons; a fieldset would alter the toolbar layout.
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex shrink-0 rounded-md border border-edge bg-surface p-0.5 ${className ?? ''}`}
    >
      {items.map((item) => {
        const active = item.value === value;
        const button = (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            aria-disabled={item.disabled || undefined}
            onClick={(event) => {
              if (item.disabled) {
                event.preventDefault();
                return;
              }
              onChange(item.value);
            }}
            className={`h-7 rounded px-2.5 text-2xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
              active
                ? 'bg-surface-overlay text-fg shadow-sm'
                : item.disabled
                  ? 'cursor-not-allowed text-fg-faint'
                  : 'text-fg-tertiary hover:bg-surface-overlay/60 hover:text-fg-body'
            }`}
          >
            {item.label}
          </button>
        );
        return item.tooltip ? (
          <Tooltip key={item.value} content={item.tooltip}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
