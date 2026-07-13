import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatTime } from '@atrium/surface-client';
import {
  formatCost,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  sessionDriverId,
  type Session,
} from './types';
import { GlanceChip } from './GlanceChip';
import { QuestionCard } from './SessionBanners';
import { sessionsApi } from './api';
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

/**
 * One-tap failure verbs, right on the card. Each is an ordinary steer posted
 * to the session thread, so the ask is visible in the conversation like any
 * other turn boundary. Retry re-runs; Ask why turns the failure into a
 * conversation instead of a wall.
 */
function SteerActionLink({
  sessionId,
  prompt,
  label,
  sentLabel,
  testid,
}: {
  sessionId: string;
  prompt: string;
  label: string;
  sentLabel: string;
  testid: string;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  if (sent) return <span className="text-2xs text-fg-muted">{sentLabel}</span>;
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        setError(false);
        sessionsApi
          .sendMessage(sessionId, prompt, undefined, true)
          .then(() => setSent(true))
          .catch(() => setError(true))
          .finally(() => setBusy(false));
      }}
      className="inline-block text-2xs font-semibold text-danger-text hover:underline disabled:opacity-60"
    >
      {error ? `${label} didn't send — try again` : label}
    </button>
  );
}

function RetryTurnAction({ sessionId }: { sessionId: string }) {
  return (
    <SteerActionLink
      sessionId={sessionId}
      prompt="Retry the failed turn."
      label="Retry turn"
      sentLabel="Retrying…"
      testid="card-retry-turn"
    />
  );
}

function AskWhyAction({ sessionId }: { sessionId: string }) {
  return (
    <SteerActionLink
      sessionId={sessionId}
      prompt="The last turn failed — explain what went wrong and what you'd try differently, then wait for my go-ahead."
      label="Ask why"
      sentLabel="Asked — check the thread"
      testid="card-ask-why"
    />
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
  meId,
  onOpen,
  onOpenPane,
  questionDisplay = 'full',
}: {
  session: Session;
  spectators: number;
  /** The optimistic POST failed — render a dead card (retry lives on the row). */
  spawnFailed?: boolean;
  /** Enables answering a live question straight from the card. */
  meId?: string;
  /**
   * Primary activation — the conversation (thread) when the caller can open
   * one. Falls back to the pane when absent.
   */
  onOpen?: (sessionId: string) => void;
  /** The workbench ("Show the work") — full transcript, plan, artifacts. */
  onOpenPane: (sessionId: string) => void;
  /**
   * How a live question renders: the full canonical card (feed/thread), or a
   * one-line "Answer →" pointer for compact surfaces (rail) so one screen
   * never holds two live answer forms.
   */
  questionDisplay?: 'full' | 'pointer';
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
  const open = () => openable && (onOpen ?? onOpenPane)(session.id);
  const openPane = () => openable && onOpenPane(session.id);
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

      {/* The card IS the channel's view of a live question — it flips to the
          canonical answerable QuestionCard in place instead of posting a
          second channel message. Compact surfaces point at it instead. */}
      {!spawnFailed &&
        !terminal &&
        session.pendingQuestion?.questions[0] &&
        (questionDisplay === 'pointer' ? (
          <button
            type="button"
            data-testid="question-pointer"
            onClick={open}
            className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border border-warning-border/40 bg-warning-tint/10 px-2 py-1.5 text-left text-xs text-warning-text-strong hover:bg-warning-tint/25"
          >
            <span className="min-w-0 flex-1 truncate">{session.pendingQuestion.questions[0].question}</span>
            <span className="shrink-0 font-semibold">Answer →</span>
          </button>
        ) : (
          <QuestionCard
            variant="card"
            sessionId={session.id}
            pending={session.pendingQuestion}
            isDriver={meId != null && sessionDriverId(session) === meId}
            driverName={session.driverName ?? session.spawnerName ?? 'the driver'}
            proposals={(session.answerProposals ?? []).filter(
              (p) => p.status === 'pending' && p.questionId === session.pendingQuestion?.questionId,
            )}
          />
        ))}

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

      {/* Failed cards render this block even with NO result text — recovery
          must not be gated on the presence of the very output whose absence
          defines the worst failures. */}
      {terminal && (session.resultText || session.status === 'failed') && (
        <div className="mt-1.5 border-l-2 border-edge-strong pl-2 text-xs leading-relaxed text-fg-secondary">
          {session.resultText ? (
            <span className="line-clamp-3 whitespace-pre-wrap break-words">{session.resultText}</span>
          ) : (
            <span className="text-fg-muted">The run ended before reporting a result.</span>
          )}
          {/* sessionDriverId, not raw driverId: feed folds create terminal
              entities with driverId null (no heal), and the seat model's
              canonical fallback is the spawner. */}
          {session.status === 'failed' && meId != null && sessionDriverId(session) === meId && (
            <span className="mt-0.5 flex items-center gap-2.5">
              <RetryTurnAction sessionId={session.id} />
              <AskWhyAction sessionId={session.id} />
            </span>
          )}
        </div>
      )}
      {openable && (
        <a
          href={session.permalink}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openPane();
          }}
          className="mt-1 inline-block text-2xs font-medium text-fg-tertiary hover:text-fg-body hover:underline"
        >
          Show the work →
        </a>
      )}
      {openable && <SessionAppPresentationCards session={session} surface="timeline" />}
    </div>
  );
}
