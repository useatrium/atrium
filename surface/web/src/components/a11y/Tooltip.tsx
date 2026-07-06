import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';
import { Kbd } from './Kbd';
import type { Chord } from '../../lib/shortcuts';

const DEFAULT_DELAY = 350;
const DEFAULT_SKIP_DELAY = 200;

/**
 * OPTIONAL. Mount once near the app root to *group* tooltip timing so moving
 * between adjacent tooltips skips the reopen delay. Not required: every
 * `<Tooltip>` embeds its own provider, so tooltips work (and never crash) with
 * or without this. Mounting it just makes a cluster of tooltips feel snappier.
 */
export function TooltipProvider({
  children,
  delayDuration = DEFAULT_DELAY,
  skipDelayDuration = DEFAULT_SKIP_DELAY,
}: {
  children: ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * Accessible tooltip: visible on hover AND keyboard focus, dismissable with
 * Escape, positioned with collision handling. Built on Radix.
 *
 * IMPORTANT: a tooltip is a *description*, not an accessible *name*. For an
 * icon-only trigger you MUST still give the trigger its own `aria-label`
 * (usually the same string as `content`) — Radix wires the tooltip via
 * `aria-describedby`, which does not name the control.
 *
 * The optional `shortcut` chord renders as decorative keycaps and is hidden
 * from assistive tech (the `content` string already conveys the action).
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration = DEFAULT_DELAY,
  children,
}: {
  content: ReactNode;
  shortcut?: Chord;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  /** A single focusable element (usually a <button>) that forwards ref + props. */
  children: ReactElement;
}) {
  // Nothing to describe -> render the trigger untouched.
  if (content == null || content === '') return children;

  // Self-contained provider: a <Tooltip> never depends on an ancestor
  // TooltipProvider, so it can't crash if one wasn't mounted. An optional
  // ancestor TooltipProvider still groups timing across a cluster.
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={DEFAULT_SKIP_DELAY}>
      <RadixTooltip.Root disableHoverableContent>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
            // pointer-events-none: a hint tooltip is informational and must never
            // intercept clicks meant for the trigger or a nearby control.
            className="pointer-events-none z-[80] flex max-w-[min(20rem,80vw)] select-none items-center gap-1.5 rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs font-medium text-fg-secondary shadow-lg"
          >
            <span>{content}</span>
            {shortcut ? <Kbd keys={shortcut} decorative className="ml-0.5" /> : null}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
