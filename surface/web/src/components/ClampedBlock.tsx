import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const ClampContext = createContext(false);

function classes(...values: Array<string | undefined | false>): string | undefined {
  const value = values.filter(Boolean).join(' ');
  return value || undefined;
}

export function ClampedBlock({
  children,
  collapsedClassName,
  collapseLabel,
  contentClassName,
  enabled = true,
  expandLabel,
  overflowingClassName,
  toggleClassName,
}: {
  children: ReactNode;
  /**
   * The size constraint, applied whenever the block is collapsed. It has to be
   * applied even when the content turns out to fit, because overflow is measured
   * THROUGH it: without the constraint, scrollHeight === clientHeight and nothing
   * would ever report as overflowing.
   */
  collapsedClassName: string;
  collapseLabel: ReactNode;
  contentClassName?: string;
  enabled?: boolean;
  expandLabel: ReactNode;
  /**
   * Styling that advertises there is more to see (a fade, say). Applied only when
   * the content actually overflows, so it stays in step with the toggle: content
   * that fits gets no toggle, and so must not get the hint either.
   */
  overflowingClassName?: string;
  toggleClassName?: string;
}) {
  const insideClamp = useContext(ClampContext);
  const canClamp = enabled && !insideClamp;
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Only measure while clamped. Expanded content does not overflow, so measuring
  // it would incorrectly remove the control that lets the user collapse it.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !canClamp || expanded) return;

    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();

    // jsdom and older browser shells do not provide ResizeObserver.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canClamp, expanded]);

  const clamped = canClamp && !expanded;
  const showToggle = canClamp && overflows;

  return (
    <>
      <div
        ref={contentRef}
        className={classes(
          contentClassName,
          clamped && collapsedClassName,
          clamped && overflows && overflowingClassName,
        )}
      >
        <ClampContext.Provider value={insideClamp || canClamp}>{children}</ClampContext.Provider>
      </div>
      {showToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={toggleClassName}
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </>
  );
}
