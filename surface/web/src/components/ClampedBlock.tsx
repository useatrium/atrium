import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react';

const ClampContext = createContext(false);

function classes(...values: Array<string | undefined | false>): string | undefined {
  const value = values.filter(Boolean).join(' ');
  return value || undefined;
}

export interface Clamp {
  /** Attach to the element that carries `collapsedClassName`. */
  contentRef: RefCallback<HTMLDivElement>;
  /** True while the content is actually being clipped. */
  clamped: boolean;
  expanded: boolean;
  /** Only true once the content is measured to exceed the clamp. */
  overflows: boolean;
  toggle: () => void;
  /** Nesting guard for children — see ClampedBlock. */
  ClampBoundary: ({ children }: { children: ReactNode }) => ReactNode;
}

/**
 * The measuring half of ClampedBlock, for callers that must place the toggle
 * themselves (EntryQuoteCard puts it in an action row beside Apply). Prefer
 * ClampedBlock when the toggle can simply follow the content.
 */
export function useClamp(enabled = true): Clamp {
  const insideClamp = useContext(ClampContext);
  const canClamp = enabled && !insideClamp;
  // The node is state, not a ref, so callers may mount the clamped element on a
  // later render than the hook — EntryQuoteCard renders it only once its markup
  // fetch resolves. A ref would attach silently, leaving this effect keyed on
  // deps that never change, so the content was never measured at all.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Only measure while clamped. Expanded content does not overflow, so measuring
  // it would incorrectly remove the control that lets the user collapse it.
  useLayoutEffect(() => {
    if (!element || !canClamp || expanded) return;

    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();

    // jsdom and older browser shells do not provide ResizeObserver.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canClamp, element, expanded]);

  const nested = insideClamp || canClamp;
  // Memoized because React keys elements by component identity: a boundary
  // rebuilt each render would be a new type every time, remounting everything
  // clamped inside it (a whole message body) on every render.
  const ClampBoundary = useCallback(
    ({ children }: { children: ReactNode }) => <ClampContext.Provider value={nested}>{children}</ClampContext.Provider>,
    [nested],
  );

  return {
    contentRef: setElement,
    clamped: canClamp && !expanded,
    expanded,
    overflows: canClamp && overflows,
    toggle: () => setExpanded((value) => !value),
    ClampBoundary,
  };
}

/**
 * A block that clips its content and offers a toggle only once it measurably
 * overflows. The clamp is published on context, so a ClampedBlock rendered
 * inside another one declines to clamp: nesting two clips made the outer one
 * bite only after the inner was released, so "Show more" SHRANK the text.
 *
 * `collapsedClassName` must carry `relative` whenever the content can hold an
 * absolutely positioned descendant — `overflow: hidden` only clips descendants
 * whose containing block runs through this box.
 */
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
  const { contentRef, clamped, expanded, overflows, toggle, ClampBoundary } = useClamp(enabled);

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
        <ClampBoundary>{children}</ClampBoundary>
      </div>
      {overflows ? (
        <button type="button" aria-expanded={expanded} onClick={toggle} className={toggleClassName}>
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </>
  );
}
