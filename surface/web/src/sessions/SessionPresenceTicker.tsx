import type { Session } from './types';

/**
 * The card's live-activity line: what the agent is doing right now
 * ("running pytest -k backoff…"). Status and clocks belong to GlanceChip —
 * this line renders only the ephemeral tool summary, and nothing at all when
 * there is none. Intentionally not live-announced: it changes as tools run
 * and would otherwise interrupt people reading or typing nearby.
 */
export function SessionPresenceTicker({ session, className = '' }: { session: Session; className?: string }) {
  const terminal = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled';
  const summary = session.latestActivity?.summary.trim();
  if (terminal || !summary) return null;

  return (
    <div
      data-testid="session-presence-ticker"
      className={`flex min-w-0 items-center gap-1.5 text-2xs text-fg-secondary ${className}`}
    >
      <span aria-live="off" title={summary} className="min-w-0 flex-1 truncate">
        {summary}
      </span>
    </div>
  );
}
