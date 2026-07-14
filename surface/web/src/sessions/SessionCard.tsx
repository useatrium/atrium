import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { formatTime } from '@atrium/surface-client';
import {
  formatCost,
  formatDurationUnits,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  sessionAnsweredQuestion,
  sessionDriverId,
  type Session,
} from './types';
import { ConversationHeader } from './ConversationHeader';
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

/**
 * The session's meta line — who spawned it, on what, since when. It lives next
 * to the identity it belongs to (the header slots it below the identity row),
 * so every surface that shows these facts shows the same facts in the same
 * order. The panel headers deliberately don't render it: the pane moved its
 * metadata into the details popover, and the thread mirrors the pane.
 *
 * Every token names itself ("by Maya Chen · codex agent"), so the row reads as
 * a sentence instead of a string of unlabelled ids. One line, always — and when
 * the line runs out it gives up space in order of importance, not in whatever
 * order flexbox finds convenient:
 *   1. the repo drops out entirely below `sm` (a repo ellipsized to "meri…" is
 *      pure noise, and it's still on the card and in the pane)
 *   2. then the harness boilerplate ellipsizes
 *   3. the author and the start time never shrink at all.
 * The author is the headline here; it is the last thing that may go. The tokens
 * are FLAT flex children (the separators are siblings, not wrappers) — nesting
 * them would hand the shrink decision back to the wrapper and re-break this.
 */
export function SessionMetaLine({ session, spectators }: { session: Session; spectators: number }) {
  return (
    <div className="mt-1 flex items-center gap-x-2 overflow-hidden whitespace-nowrap text-2xs text-fg-muted">
      <span className="shrink-0">by {session.spawnerName ?? session.spawnedBy}</span>
      {session.driverId !== null && session.driverId !== session.spawnedBy && (
        <>
          <span className="shrink-0 text-fg-faint">·</span>
          <span className="min-w-0 truncate text-fg-tertiary">driver: {session.driverName ?? session.driverId}</span>
        </>
      )}
      <span className="shrink-0 text-fg-faint">·</span>
      {/* Long, low-information boilerplate — it yields before any name does. */}
      <span className="min-w-0 shrink-[3] truncate">{session.harness} agent</span>
      {session.repo && (
        <>
          <span className="hidden shrink-0 text-fg-faint sm:inline">·</span>
          <span className="hidden min-w-0 truncate sm:inline" title={repoBranchTitle(session.repo, session.branch)}>
            {repoBranchLabel(session.repo, session.branch)}
          </span>
        </>
      )}
      <span className="shrink-0 text-fg-faint">·</span>
      <span className="shrink-0 tabular-nums">started {formatTime(session.createdAt)}</span>
      {session.costUsd > 0 && (
        <>
          <span className="shrink-0 text-fg-faint">·</span>
          <span className="shrink-0 tabular-nums">{formatCost(session.costUsd)}</span>
        </>
      )}
      {spectators > 0 && (
        <>
          <span className="shrink-0 text-fg-faint">·</span>
          <span className="shrink-0 tabular-nums">{spectators} watching</span>
        </>
      )}
    </div>
  );
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
 * The card's actions read as quiet links on a mouse, but a 14px line of text
 * is not a tap target. On coarse pointers they grow to the 44px minimum
 * (WCAG 2.5.8) without gaining a button's chrome — same idiom the composer's
 * audience pill and the pane's icon buttons use.
 */
const TOUCH_TARGET =
  '[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center';

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
      className={`inline-block text-2xs font-semibold text-danger-text hover:underline disabled:opacity-60 ${TOUCH_TARGET}`}
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
  const livePending = !terminal && session.pendingQuestion?.questions[0] ? session.pendingQuestion : null;
  const answered = sessionAnsweredQuestion(session);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The same surfaces that can't host a live answer form (the rail) can't host
  // the card's trailing controls either — both are "this is a peek" surfaces.
  const compact = questionDisplay === 'pointer';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: card click mirrors the nested status button; keyboard users use that button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: card click mirrors the nested status button; keyboard users use that button.
    <div
      data-testid="session-card"
      // The card no longer prints the task, so it can't be found by its text.
      // This is the stable handle for "the card for THIS session".
      data-session-id={session.id}
      onClick={onCardClick}
      className={`group/card mt-1 max-w-2xl rounded-lg border border-edge bg-surface-raised/70 px-3 py-2 ${
        openable ? 'cursor-pointer hover:border-edge-strong' : ''
      }`}
    >
      {/* The identity row + meta line are the SHARED header (see
          ConversationHeader): the same chip · meta the thread and the pane pin
          to the top of the right panel. The card alone hides the title — the
          spawner's ask is rendered as their own message directly above it, so
          repeating it here is an echo, not an identity. */}
      <ConversationHeader
        variant="card"
        hideTitle
        identity={{
          kind: 'session',
          session,
          now,
          // One clock: the terminal strip next to the chip already says how long
          // the run took.
          ...(terminal ? { showClock: false } : {}),
          ...(spawnFailed ? { glanceOverride: { kind: 'failed' as const, label: 'spawn failed' } } : {}),
        }}
        onOpenTitle={openable ? open : undefined}
        // The rail is a peek, not a workbench: it gets the chip and the elapsed
        // line, and clicking it opens the session. Hanging "Session details" and
        // "Show the work" off a 200px-wide card just collides them.
        actions={
          compact ? (
            terminal ? (
              <span className="min-w-0 flex-1 text-xs text-fg-secondary">
                {session.status === 'failed' ? 'Agent failed after' : 'Agent worked'}{' '}
                {formatDurationUnits(Math.max(0, sessionElapsedMs(session, now)))}
              </span>
            ) : null
          ) : (
            // Its own wrappable row: `flex-1` on a bare span means flex-basis 0,
            // and once the recovery links joined the strip the elapsed text
            // collapsed to width 0 at phone widths and overprinted them. Grow
            // from the natural width instead, and let the links wrap under.
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
              {terminal && (
                <span className="grow whitespace-nowrap text-xs text-fg-secondary">
                  {session.status === 'failed' ? 'Agent failed after' : 'Agent worked'}{' '}
                  {formatDurationUnits(Math.max(0, sessionElapsedMs(session, now)))}
                </span>
              )}
              {terminal && session.status === 'failed' && meId != null && sessionDriverId(session) === meId && (
                <>
                  <RetryTurnAction sessionId={session.id} />
                  <AskWhyAction sessionId={session.id} />
                </>
              )}
              <button
                type="button"
                data-testid="card-details-toggle"
                aria-expanded={detailsOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setDetailsOpen((v) => !v);
                }}
                className={`shrink-0 text-2xs text-fg-muted hover:text-fg-secondary hover:underline ${TOUCH_TARGET}`}
              >
                {detailsOpen ? 'Hide details' : 'Session details'}
              </button>
              {openable && (
                <a
                  href={session.permalink}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openPane();
                  }}
                  className={`shrink-0 text-2xs font-medium text-fg-tertiary hover:text-fg-body hover:underline ${TOUCH_TARGET}`}
                >
                  Show the work →
                </a>
              )}
            </span>
          )
        }
        meta={detailsOpen && !compact ? <SessionMetaLine session={session} spectators={spectators} /> : undefined}
      >
        {/* A finished run says what it did in its own reply message below, so a
            terminal card carries no ticker and no result excerpt — only how long
            it took and the way back in. */}
        {!spawnFailed && !terminal && <SessionPresenceTicker session={session} className="mt-1 pl-0.5" />}

        {/* The card IS the channel's view of a live question — it flips to the
            canonical answerable QuestionCard in place instead of posting a
            second channel message, and the QuestionCard keeps the seat once the
            question resolves: "✓ Answered by <name> · <option>". Compact
            surfaces (the rail) point at a LIVE question instead, and show
            nothing once it's answered. */}
        {!spawnFailed &&
          (livePending && questionDisplay === 'pointer' ? (
            <button
              type="button"
              data-testid="question-pointer"
              onClick={open}
              className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border border-warning-border/40 bg-warning-tint/10 px-2 py-1.5 text-left text-xs text-warning-text-strong hover:bg-warning-tint/25"
            >
              <span className="min-w-0 flex-1 truncate">{livePending.questions[0]?.question}</span>
              <span className="shrink-0 font-semibold">Answer →</span>
            </button>
          ) : questionDisplay === 'full' && (livePending || answered) ? (
            <QuestionCard
              variant="card"
              sessionId={session.id}
              pending={livePending}
              answered={answered}
              isDriver={meId != null && sessionDriverId(session) === meId}
              driverName={session.driverName ?? session.spawnerName ?? 'the driver'}
              proposals={(session.answerProposals ?? []).filter(
                (p) => p.status === 'pending' && p.questionId === livePending?.questionId,
              )}
            />
          ) : null)}
      </ConversationHeader>
      {openable && <SessionAppPresentationCards session={session} surface="timeline" />}
    </div>
  );
}
