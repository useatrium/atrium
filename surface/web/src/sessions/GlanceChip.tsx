import {
  deriveSessionGlance,
  sessionGlanceClockLabel,
  type SessionGlance,
  type SessionGlanceInput,
  type SessionGlanceKind,
} from './types';

const KIND_STYLES: Record<SessionGlanceKind, string> = {
  working: 'bg-accent-hover/15 text-accent-text-strong',
  needs_you: 'bg-warning/15 text-warning-text-strong',
  stalled: 'bg-surface-overlay/80 text-fg-tertiary',
  done: 'bg-success/15 text-success-text',
  failed: 'bg-danger/15 text-danger-text',
  stopped: 'bg-edge-strong/40 text-fg-tertiary',
};

/**
 * The one status chip. Every surface that names a session's state renders this
 * — never the raw DB status — so "Needs you" means the same thing on the feed
 * card, the rail, the Agents page, the pane header, and Attention. Shows at
 * most one clock (the one-clock rule lives in deriveSessionGlance).
 */
export function GlanceChip({
  session,
  now,
  stuck,
  override,
  showClock = true,
  className = '',
}: {
  session: SessionGlanceInput;
  /** Caller's ticker (cards already run one); defaults to render-time now. */
  now?: number;
  /** Live-transcript stall verdict — only the pane can know this. */
  stuck?: boolean;
  /** Rare display exception, e.g. a dead optimistic card's "spawn failed". */
  override?: { kind: SessionGlanceKind; label: string };
  showClock?: boolean;
  className?: string;
}) {
  const at = now ?? Date.now();
  const derived = deriveSessionGlance(session, at, { stuck });
  const glance: SessionGlance = override
    ? { kind: override.kind, label: override.label, pulse: false, clock: null }
    : derived;
  const clock = showClock ? sessionGlanceClockLabel(glance, at) : null;
  return (
    <span
      data-testid="glance-chip"
      data-kind={glance.kind}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${KIND_STYLES[glance.kind]} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full bg-current ${glance.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
      />
      <span aria-live="polite" aria-atomic="true">
        {glance.label}
        {glance.detail ? <span className="font-medium opacity-80"> · {glance.detail}</span> : null}
      </span>
      {clock && (
        <span aria-live="off" className="font-medium tabular-nums opacity-80">
          {clock}
        </span>
      )}
    </span>
  );
}
