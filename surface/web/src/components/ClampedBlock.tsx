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
  toggleClassName,
}: {
  children: ReactNode;
  collapsedClassName: string;
  collapseLabel: ReactNode;
  contentClassName?: string;
  enabled?: boolean;
  expandLabel: ReactNode;
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
      <div ref={contentRef} className={classes(contentClassName, clamped && collapsedClassName)}>
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
