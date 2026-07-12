import { formatElapsed } from './types';
import type { Session } from './types';
import { sessionElapsedMs, useNow } from './SessionCard';

type PresenceState = {
  label: string;
  tone: 'working' | 'awaiting' | 'done' | 'failed' | 'quiet';
};

function presenceState(session: Session): PresenceState {
  if (session.pendingQuestion) return { label: 'Awaiting input', tone: 'awaiting' };
  if (session.status === 'completed') return { label: 'Done', tone: 'done' };
  if (session.status === 'failed') return { label: 'Failed', tone: 'failed' };
  if (session.status === 'cancelled') return { label: 'Cancelled', tone: 'quiet' };
  if (session.status === 'queued' || session.status === 'spawning') return { label: 'Starting', tone: 'working' };
  return { label: 'Working', tone: 'working' };
}

const TONES: Record<PresenceState['tone'], string> = {
  working: 'text-accent-text-strong',
  awaiting: 'text-warning-text-strong',
  done: 'text-success-text',
  failed: 'text-danger-text',
  quiet: 'text-fg-tertiary',
};

/**
 * A compact, stable view of an agent session's current state. The activity
 * summary is intentionally not live-announced: it changes as tools run and
 * would otherwise interrupt people reading or typing nearby.
 */
export function SessionPresenceTicker({ session, className = '' }: { session: Session; className?: string }) {
  const terminal = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled';
  const now = useNow(!terminal);
  const state = presenceState(session);
  const summary = session.latestActivity?.summary.trim();

  return (
    <div
      data-testid="session-presence-ticker"
      className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs ${className}`}
    >
      <span className={`inline-flex shrink-0 items-center gap-1 font-semibold ${TONES[state.tone]}`}>
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full bg-current ${state.tone === 'working' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        />
        <span aria-live="polite" aria-atomic="true">
          {state.tone === 'awaiting' ? '● ' : ''}
          {state.label}
        </span>
      </span>
      <span aria-hidden="true" className="text-fg-faint">
        ·
      </span>
      <span aria-live="off" className="shrink-0 tabular-nums text-fg-muted">
        {formatElapsed(sessionElapsedMs(session, now))}
      </span>
      {summary && (
        <>
          <span aria-hidden="true" className="hidden text-fg-faint sm:inline">
            ·
          </span>
          <span
            aria-live="off"
            title={summary}
            className="min-w-0 basis-full truncate text-fg-secondary sm:basis-auto sm:flex-1"
          >
            {summary}
          </span>
        </>
      )}
    </div>
  );
}
