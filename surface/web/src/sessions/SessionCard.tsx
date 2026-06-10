import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatTime } from '../util';
import {
  formatCost,
  formatElapsed,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  type Session,
  type SessionStatus,
} from './types';

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
  spawning: 'bg-amber-500/15 text-amber-300 animate-pulse',
  queued: 'bg-sky-500/15 text-sky-300',
  running: 'bg-indigo-500/15 text-indigo-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  cancelled: 'bg-zinc-700/40 text-zinc-400',
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        stalled ? 'bg-zinc-800/80 text-zinc-400' : CHIP_STYLES[status]
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
  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      data-testid="session-card"
      onClick={open}
      onKeyDown={onCardKeyDown}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-label={openable ? `Open session: ${session.title}` : undefined}
      className={`group/card mt-1 max-w-xl rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 ${
        openable ? 'cursor-pointer hover:border-zinc-700' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        {spawnFailed ? (
          <StatusChip status="failed" label="spawn failed" />
        ) : (
          <StatusChip status={session.status} stalled={stalled} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
          {session.title}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
        <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
        {session.driverId !== null && session.driverId !== session.spawnedBy && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="truncate text-zinc-400">
              driver: {session.driverName ?? session.driverId}
            </span>
          </>
        )}
        <span className="text-zinc-700">·</span>
        <span>{session.harness}</span>
        <span className="text-zinc-700">·</span>
        {stalled ? (
          <span className="tabular-nums">started {formatTime(session.createdAt)}</span>
        ) : (
          <span className="tabular-nums">{formatElapsed(sessionElapsedMs(session, now))}</span>
        )}
        {session.costUsd > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="tabular-nums">{formatCost(session.costUsd)}</span>
          </>
        )}
        {spectators > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="tabular-nums">
              {spectators} watching
            </span>
          </>
        )}
        {openable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="ml-auto font-medium text-indigo-400 opacity-0 transition-opacity hover:underline focus:opacity-100 group-hover/card:opacity-100"
          >
            open pane →
          </button>
        )}
      </div>

      {terminal && session.resultText && (
        <div className="mt-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-relaxed text-zinc-300">
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
            className="mt-0.5 inline-block text-[11px] font-medium text-indigo-400 hover:underline"
          >
            permalink
          </a>
        </div>
      )}
    </div>
  );
}
