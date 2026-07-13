import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatTime } from '@atrium/surface-client';
import { formatCost, isPendingSessionId, isStalledSessionStatus, isTerminalSessionStatus, type Session } from './types';
import { GlanceChip } from './GlanceChip';
import { InlineQuestionAnswer } from './InlineQuestionAnswer';
import { SessionAppPresentationCards } from './AppPresentationCard';
import { SessionPresenceTicker } from './SessionPresenceTicker';

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
  meId,
  onOpenPane,
}: {
  session: Session;
  spectators: number;
  /** The optimistic POST failed — render a dead card (retry lives on the row). */
  spawnFailed?: boolean;
  /** Enables answering a live question straight from the card. */
  meId?: string;
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
          <GlanceChip session={session} override={{ kind: 'failed', label: 'spawn failed' }} />
        ) : (
          <GlanceChip session={session} now={now} />
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

      {!spawnFailed && <SessionPresenceTicker session={session} className="mt-1 pl-0.5" />}

      {/* The card IS the channel's view of a live question — it flips to
          answerable in place instead of posting a second channel message. */}
      {!spawnFailed && !terminal && session.pendingQuestion?.questions[0] && (
        <div className="mt-1.5 rounded-md border border-warning-border/40 bg-warning-tint/10 px-2 py-1.5 text-xs">
          <div className="whitespace-pre-wrap break-words text-fg-body">
            {session.pendingQuestion.questions[0].question}
          </div>
          <InlineQuestionAnswer session={session} meId={meId} />
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
        <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
        {session.driverId !== null && session.driverId !== session.spawnedBy && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="truncate text-fg-tertiary">driver: {session.driverName ?? session.driverId}</span>
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
        <span className="tabular-nums">started {formatTime(session.createdAt)}</span>
        {session.costUsd > 0 && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="tabular-nums">{formatCost(session.costUsd)}</span>
          </>
        )}
        {spectators > 0 && (
          <>
            <span className="text-fg-faint">·</span>
            <span className="tabular-nums">{spectators} watching</span>
          </>
        )}
      </div>

      {terminal && session.resultText && (
        <div className="mt-1.5 border-l-2 border-edge-strong pl-2 text-xs leading-relaxed text-fg-secondary">
          <span className="line-clamp-3 whitespace-pre-wrap break-words">{session.resultText}</span>
          <a
            href={session.permalink}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open();
            }}
            className="mt-0.5 inline-block text-2xs font-medium text-accent-text hover:underline"
          >
            Open session
          </a>
        </div>
      )}
      {openable && <SessionAppPresentationCards session={session} surface="timeline" />}
    </div>
  );
}
