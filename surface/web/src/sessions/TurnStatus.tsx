import { formatCost, formatElapsed } from './types';

/** A small CSS spinner, accent-colored via `currentColor`. Used for the
 *  turn status line and per-tool "running" state. */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  );
}

export type TurnPhase = 'thinking' | 'tool' | 'waiting' | 'done';

/**
 * One subtle status line pinned above the composer — the turn's meta, updating
 * in place (running → done) like the Claude/Codex CLIs, NOT a transcript entry.
 * Keeps the pane from ever looking frozen even when the harness emits no
 * reasoning summaries. Harness-agnostic (driven by session/stream status).
 */
export function TurnStatusLine({
  phase,
  label,
  elapsedMs,
  costUsd,
  models,
}: {
  phase: TurnPhase;
  label: string;
  elapsedMs: number;
  costUsd: number;
  models: string[];
}) {
  const active = phase === 'thinking' || phase === 'tool';
  const showMeta = costUsd > 0 || models.length > 0;
  return (
    <div
      data-testid="turn-status"
      className="flex shrink-0 items-center gap-2 border-t border-edge px-3.5 py-1.5 text-2xs text-fg-muted"
    >
      {active ? (
        <>
          <Spinner className="text-accent-text-strong" />
          <span className="animate-pulse font-medium text-accent-text-strong">{label}…</span>
        </>
      ) : phase === 'waiting' ? (
        <span className="font-medium">{label}</span>
      ) : (
        <span className="font-medium text-fg-secondary">✓ {label}</span>
      )}
      {active && elapsedMs >= 1000 && (
        <span className="tabular-nums text-fg-faint">{formatElapsed(elapsedMs)}</span>
      )}
      {showMeta && (
        <span className="ml-auto flex items-center gap-1.5 tabular-nums text-fg-faint">
          {costUsd > 0 && <span>{formatCost(costUsd)}</span>}
          {costUsd > 0 && models.length > 0 && <span>·</span>}
          {models.length > 0 && <span>{models.join(', ')}</span>}
        </span>
      )}
    </div>
  );
}
