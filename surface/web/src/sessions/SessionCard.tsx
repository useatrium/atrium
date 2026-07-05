import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatTime } from '@atrium/surface-client';
import {
  formatCost,
  formatElapsed,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  type Session,
  type SessionStatus,
} from './types';
import { SessionAppPresentationCards } from './AppPresentationCard';

/** Compact "repo@branch" label for the metadata line (branch optional). */
export function repoBranchLabel(repo: string, branch?: string | null): string {
  return branch ? `${repo}@${branch}` : repo;
}
export function repoBranchTitle(repo: string, branch?: string | null): string {
  return branch ? `${repo} · branch ${branch}` : repo;
}

/** 1s ticker for live elapsed displays; idle when `active` is false. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const CHIP_STYLES: Record<SessionStatus, string> = {
  spawning: 'bg-warning/15 text-warning-text animate-pulse',
  queued: 'bg-info/15 text-info-text',
  running: 'bg-accent-hover/15 text-accent-text-strong',
  completed: 'bg-success/15 text-success-text',
  failed: 'bg-danger/15 text-danger-text',
  cancelled: 'bg-edge-strong/40 text-fg-tertiary',
};

/** Human labels where the raw status is dev-speak. */
const CHIP_LABELS: Partial<Record<SessionStatus, string>> = { spawning: 'starting' };

export function StatusChip({
  status,
  label,
  stalled,
}: {
  status: SessionStatus;
  label?: string;
  /** Non-terminal status that stopped moving — render static, no pulse. */
  stalled?: boolean;
}) {
  const animatedDot = !stalled && (status === 'queued' || status === 'running');
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${
        stalled ? 'bg-surface-overlay/80 text-fg-tertiary' : CHIP_STYLES[status]
      }`}
    >
      <span
        className={`size-1.5 rounded-full bg-current ${animatedDot ? 'animate-pulse' : ''}`}
      />
      {label ?? (stalled ? 'stalled' : (CHIP_LABELS[status] ?? status))}
    </span>
  );
}

export function sessionElapsedMs(session: Session, now: number): number {
  const start = new Date(session.createdAt).getTime();
  const end = session.completedAt ? new Date(session.completedAt).getTime() : now;
  return end - start;
}

/**
 * Live agent-session card, rendered in the timeline/thread where the
 * session.spawned event sits. Re-renders purely off entity updates folded
 * from session.* WS events — no refetch.
 */
export function SessionCard({
  session,
  spectators,
  spawnFailed,
  onOpenPane,
}: {
  session: Session;
  spectators: number;
  /** The optimistic POST failed — render a dead card (retry lives on the row). */
  spawnFailed?: boolean;
  onOpenPane: (sessionId: string) => void;
}) {
  const terminal = isTerminalSessionStatus(session.status);
  // Stop the 1s ticker once a card goes stalled — the gate trails by one
  // render via the ref, which costs at most a single extra tick.
  const stalledRef = useRef(false);
  const now = useNow(!terminal && !spawnFailed && !stalledRef.current);
  const stalled = !terminal && !spawnFailed && isStalledSessionStatus(session, now);
  stalledRef.current = stalled;
  const pending = isPendingSessionId(session.id);
  const openable = !pending && !spawnFailed;
  const open = () => openable && onOpenPane(session.id);
  const onCardClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button,a')) return;
    open();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: card click mirrors the nested title button; keyboard users use that button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: card click mirrors the nested title button; keyboard users use that button.
    <div
      data-testid="session-card"
      onClick={onCardClick}
      className={`group/card mt-1 max-w-2xl rounded-lg border border-edge bg-surface-raised/70 px-3 py-2 ${
        openable ? 'cursor-pointer hover:border-edge-strong' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        {spawnFailed ? (
          <StatusChip status="failed" label="spawn failed" />
        ) : session.providerAuthRequired ? (
          <StatusChip status="running" label="needs auth" stalled />
        ) : session.pendingQuestion ? (
          <StatusChip status="running" label="needs input" stalled />
        ) : (
          <StatusChip status={session.status} stalled={stalled} />
        )}
        {openable ? (
          <button
            type="button"
            onClick={open}
            className="min-w-0 flex-1 whitespace-pre-wrap break-words text-left text-sm font-medium leading-snug text-fg hover:underline focus-visible:underline"
          >
            {session.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium leading-snug text-fg">
            {session.title}
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
        <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
        {session.driverId !== null && session.driverId !== session.spawnedBy && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="truncate text-fg-tertiary">
              driver: {session.driverName ?? session.driverId}
            </span>
          </>
        )}
        <span className="text-fg-faint">·</span>
        <span>{session.harness}</span>
        {session.repo && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="truncate" title={repoBranchTitle(session.repo, session.branch)}>
              {repoBranchLabel(session.repo, session.branch)}
            </span>
          </>
        )}
        <span className="text-fg-faint">·</span>
        {stalled ? (
          <span className="tabular-nums">started {formatTime(session.createdAt)}</span>
        ) : (
          <span className="tabular-nums">{formatElapsed(sessionElapsedMs(session, now))}</span>
        )}
        {session.costUsd > 0 && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="tabular-nums">{formatCost(session.costUsd)}</span>
          </>
        )}
        {spectators > 0 && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="tabular-nums">
              {spectators} watching
            </span>
          </>
        )}
      </div>

      {terminal && session.resultText && (
        <div className="mt-1.5 border-l-2 border-edge-strong pl-2 text-xs leading-relaxed text-fg-secondary">
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {session.resultText}
          </span>
          <a
            href={session.permalink}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open();
            }}
            className="mt-0.5 inline-block text-2xs font-medium text-accent-text hover:underline"
          >
            Open full transcript
          </a>
        </div>
      )}
      {openable && <SessionAppPresentationCards session={session} surface="timeline" />}
    </div>
  );
}
