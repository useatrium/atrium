import { useId, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { formatExactTimestamp } from '@atrium/surface-client';

export function TimestampDisclosure({
  iso,
  children,
  className,
  label,
  testId,
  align = 'left',
}: {
  iso: string;
  children: ReactNode;
  className?: string;
  label?: string;
  testId?: string;
  align?: 'left' | 'right';
}) {
  const exact = formatExactTimestamp(iso);
  const tooltipId = useId();
  const [pinned, setPinned] = useState(false);

  if (!exact)
    return (
      <span data-testid={testId} className={className}>
        {children}
      </span>
    );

  const stopPointer = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setPinned((value) => !value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      setPinned(false);
      event.currentTarget.blur();
    }
  };
  const tooltipSide = align === 'right' ? 'right-0' : 'left-0';
  // No hover:none always-show: on touch devices every ungrouped message would
  // render its tooltip open on load, overlapping the text below. Touch users
  // tap the timestamp to pin the exact time instead.
  const tooltipVisibility = pinned
    ? 'opacity-100'
    : 'opacity-0 group-hover/timestamp:opacity-100 group-focus-visible/timestamp:opacity-100';
  const accessibleLabel = label ? `${label}. Exact timestamp: ${exact}` : `Exact timestamp: ${exact}`;

  return (
    <button
      type="button"
      title={exact}
      aria-label={accessibleLabel}
      aria-describedby={pinned ? tooltipId : undefined}
      onPointerDown={stopPointer}
      onClick={toggle}
      onKeyDown={onKeyDown}
      onBlur={() => setPinned(false)}
      className={`group/timestamp relative inline-flex min-w-0 items-baseline rounded px-0.5 text-left text-inherit underline-offset-2 hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-strong ${className ?? ''}`}
    >
      <span data-testid={testId}>{children}</span>
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute top-full ${tooltipSide} z-30 mt-1 max-w-[min(20rem,80vw)] whitespace-nowrap rounded border border-edge-strong bg-surface-overlay px-1.5 py-1 text-3xs font-medium text-fg-secondary shadow-lg transition-opacity ${tooltipVisibility}`}
      >
        {exact}
      </span>
    </button>
  );
}
