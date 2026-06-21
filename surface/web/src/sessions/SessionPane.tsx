import {
  Fragment,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  artifactCount,
  changedPaths,
  codexInlineFileChanges,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  fileChangeFromToolCall,
  isTerminalExecutionStatus,
  sideEffectCount,
  type QuestionItem,
  type TextItem,
  type ToolCallItem,
  type UserMessageItem,
} from '@atrium/centaur-client';
import { ApiError } from '../api';
import { WorkDrawer, type WorkTab } from './WorkDrawer';
import { useConflicts } from './useConflicts';
import { InlineFileChange } from './fileChangeView';
import { Composer } from '../components/Composer';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExpandIcon,
  ExternalLinkIcon,
  ShrinkIcon,
  XIcon,
} from '../components/icons';
import type { UserRef } from '@atrium/surface-client';
import { formatTime, randomId } from '@atrium/surface-client';
import { sessionsApi } from './api';
import { StatusChip, repoBranchLabel, repoBranchTitle, sessionElapsedMs, useNow } from './SessionCard';
import {
  formatCost,
  formatElapsed,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
  sessionDriverId,
  type SeatAuditEntry,
  type QuestionPrompt,
  type Session,
  type SessionSuggestion,
  type SessionAnswerProposal,
  type SessionQuestionAnswerSummary,
  type SessionQuestionEvent,
  type SessionStatus,
} from './types';
import { useSessionStream } from './useSessionStream';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

export function SessionPane({
  session,
  me,
  watchers,
  typers = [],
  onComposerTyping,
  onClose,
  onAnswerQuestion,
  onSteer = async () => {},
  failedSteer = null,
  onClearFailedSteer = () => {},
  onCancelSession = async () => {},
  failedCancel = false,
  onClearFailedCancel = () => {},
  layout = 'split',
  onToggleFocus,
}: {
  session: Session;
  me: UserRef;
  /** Presence list for `session:<id>` — everyone with this pane open. */
  watchers: UserRef[];
  /** Others currently composing a steer/suggestion here (excludes me). */
  typers?: UserRef[];
  /** Throttle at the call site; fired while the composer has text. */
  onComposerTyping?: () => void;
  onClose: () => void;
  onAnswerQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSteer?: (sessionId: string, text: string) => Promise<void>;
  failedSteer?: string | null;
  onClearFailedSteer?: () => void;
  onCancelSession?: (sessionId: string) => Promise<void>;
  failedCancel?: boolean;
  onClearFailedCancel?: () => void;
  /** 'split' = peek beside the channel; 'focus' = full-width, channel hidden. */
  layout?: 'split' | 'focus';
  /** Toggle between split and focus; omit to hide the expand control. */
  onToggleFocus?: () => void;
}) {
  const { stream, connected } = useSessionStream(session.id);

  // Changes work-surface (Phase 4): Claude/amp edits from the transcript items +
  // codex fileChange edits the reducer captured.
  const fileChanges = useMemo(
    () => collectFileChanges(stream),
    [stream.items, stream.fileChanges],
  );
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
  const sideEffects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const sideEffectsN = useMemo(() => sideEffectCount(sideEffects), [sideEffects]);
  const sideEffectsDanger = useMemo(
    () => sideEffects.some((effect) => effect.risk === 'danger'),
    [sideEffects],
  );
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  // Live conflict feed (A3): polls the ledger change-feed for status=conflict
  // versions and hydrates their both-sides detail for the Conflicts tab.
  // Inert under unit tests (which assert exact global-fetch call counts); fully
  // live in dev/prod. The hook itself is covered in useConflicts.test.tsx.
  const { conflicts, resolve: resolveConflict } = useConflicts(session.id, {
    enabled: import.meta.env.MODE !== 'test',
  });
  const conflictsN = conflicts.length;

  // Work drawer (Phase 4): one tabbed surface over Changes + Side-effects, with
  // a peek→pin ladder. `workTab` null = closed; `workPinned` docks it beside the
  // transcript. Pinning gives the transcript room by collapsing to focus (the
  // ratified pane-cap rule); we restore split on unpin only if pin caused it.
  const [workTab, setWorkTab] = useState<WorkTab | null>(null);
  const [workPinned, setWorkPinned] = useState(false);
  const workAutoFocusedRef = useRef(false);
  const restoreSplitIfAuto = () => {
    if (workAutoFocusedRef.current && onToggleFocus) {
      workAutoFocusedRef.current = false;
      onToggleFocus();
    }
  };
  const closeWork = () => {
    setWorkTab(null);
    setWorkPinned(false);
    restoreSplitIfAuto();
  };
  const onStrip = (tab: WorkTab) => {
    if (workTab === tab && !workPinned) closeWork();
    else setWorkTab(tab);
  };
  const togglePin = () => {
    if (workPinned) {
      setWorkPinned(false);
      restoreSplitIfAuto();
    } else {
      setWorkPinned(true);
      if (layout === 'split' && onToggleFocus) {
        workAutoFocusedRef.current = true;
        onToggleFocus();
      }
    }
  };

  const terminal = isTerminalSessionStatus(session.status);
  const displayStatus: SessionStatus = terminal
    ? session.status
    : stream.status !== 'idle'
      ? normalizeExecutionStatus(stream.status)
      : session.status;
  const displayTerminal = isTerminalSessionStatus(displayStatus);
  // A completed session is idle/resumable (a steer regresses completed→queued),
  // NOT ended — only failed/cancelled are truly read-only.
  const isEnded = displayStatus === 'failed' || displayStatus === 'cancelled';
  const now = useNow(!displayTerminal);
  const stalled = !displayTerminal && stream.status === 'idle' && isStalledSessionStatus(session, now);
  const costUsd = Math.max(session.costUsd, stream.costUsd);
  const resultText = stream.resultText || session.resultText || '';
  const isSpawner = session.spawnedBy === me.id;
  const spectators = watchers.length;
  const pendingQuestion =
    session.pendingQuestion !== undefined ? session.pendingQuestion : stream.pendingQuestion;
  const questionEvents = session.questionEvents ?? [];
  const questionEventsByQuestion = useMemo(
    () => groupQuestionEventsByQuestion(questionEvents),
    [questionEvents],
  );

  // ---- driver seat (Phase 3) ----
  const driverId = sessionDriverId(session);
  const isDriver = driverId === me.id;
  const driverPresent = isDriver || watchers.some((u) => u.id === driverId);

  const nameFor = (userId: string | null): string => {
    if (!userId) return 'someone';
    if (userId === me.id) return me.displayName;
    const watcher = watchers.find((u) => u.id === userId);
    if (watcher) return watcher.displayName;
    if (userId === session.driverId && session.driverName) return session.driverName;
    if (userId === session.spawnedBy && session.spawnerName) return session.spawnerName;
    const req = session.pendingSeatRequests.find((r) => r.userId === userId);
    if (req) return req.displayName;
    return userId;
  };
  const driverName = nameFor(driverId);
  // Steer frames carry no author; attribute to the spawner (Phase-1 approximation —
  // per-steer seat-aware attribution arrives with the session record in Phase 2).
  const steerAuthor = nameFor(session.spawnedBy);
  // Turn navigation skeleton: index the steers (the user's turns), not agent replies.
  const turns = useMemo(
    () =>
      stream.items
        .filter((it): it is UserMessageItem => it.type === 'user_message')
        .map((it) => ({ id: it.id, text: it.text })),
    [stream.items],
  );

  // Spectator → driver ask state. 'confirm-take' = take clicked once, waiting
  // for confirmation; 'seat-held' = a take bounced with 409 and we fell back
  // to a request.
  const [seatAsk, setSeatAsk] = useState<'idle' | 'confirm-take' | 'requested' | 'seat-held'>(
    'idle',
  );
  useEffect(() => {
    if (isDriver) setSeatAsk('idle');
  }, [isDriver]);
  // Unconfirmed take reverts on its own — it shouldn't linger as a landmine.
  useEffect(() => {
    if (seatAsk !== 'confirm-take') return;
    const t = setTimeout(() => setSeatAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [seatAsk]);
  const seatRequested =
    seatAsk === 'requested' ||
    seatAsk === 'seat-held' ||
    session.pendingSeatRequests.some((r) => r.userId === me.id);

  const requestSeat = () => {
    setSeatAsk('requested');
    sessionsApi.requestSeat(session.id).catch(() => setSeatAsk('idle'));
  };
  const takeSeat = () => {
    setSeatAsk('idle');
    sessionsApi.takeSeat(session.id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Seat actually held (driver is watching after all) — note it and
        // fall back to a polite request.
        setSeatAsk('seat-held');
        sessionsApi.requestSeat(session.id).catch(() => {});
      }
    });
  };

  // Driver steer sends: never swallow a lost instruction — keep the text and
  // surface a retry right where the action happened.
  const [localSteerError, setLocalSteerError] = useState<string | null>(null);
  const steerError = localSteerError ?? failedSteer;
  const sendSteer = (text: string) => {
    setLocalSteerError(null);
    onClearFailedSteer();
    onSteer(session.id, text).catch(() => setLocalSteerError(text));
  };

  // Suggestion queue (Phase 2). Spectators compose suggestions; the driver
  // sends / edits-then-sends / dismisses them. Resolved rows persist; only
  // pending ones are actionable, and the queue is visible to everyone so the
  // room can see what's been proposed.
  const pendingSuggestions = useMemo(
    () => (session.suggestions ?? []).filter((s) => s.status === 'pending'),
    [session.suggestions],
  );
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const sendSuggestion = (text: string) => {
    setSuggestError(null);
    sessionsApi.createSuggestion(session.id, text, randomId()).catch(() => setSuggestError(text));
  };

  // Pending HITL answer proposals for the live question (driver decides).
  const questionProposals = useMemo(
    () =>
      (session.answerProposals ?? []).filter(
        (p) => p.status === 'pending' && p.questionId === pendingQuestion?.questionId,
      ),
    [session.answerProposals, pendingQuestion],
  );

  // Cancel is destructive and possibly shared — two-step inline confirm.
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  const displayCancelAsk = failedCancel ? 'failed' : cancelAsk;
  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const t = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [cancelAsk]);
  const onCancel = () => {
    if (displayCancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    onClearFailedCancel();
    onCancelSession(session.id).catch(() => setCancelAsk('failed'));
  };

  // Driver-side grant banner; Ignore is a local dismissal only.
  const [ignoredRequests, setIgnoredRequests] = useState<ReadonlySet<string>>(new Set());
  const seatRequest = isDriver
    ? session.pendingSeatRequests.find((r) => !ignoredRequests.has(r.userId)) ?? null
    : null;

  // Audit-line anchoring: a seat line renders right after the transcript items
  // that were already visible when it arrived (append-like, chronological).
  // Entries that predate the pane mount (full reload / reopening the pane)
  // have no arrival point — v0 limitation: they render grouped after the
  // transcript content instead of interleaved at their original positions.
  const seatAnchorsRef = useRef<Map<number, number> | null>(null);
  if (seatAnchorsRef.current === null) {
    seatAnchorsRef.current = new Map(
      session.seatEvents.map((e) => [e.id, Number.MAX_SAFE_INTEGER]),
    );
  }
  const seatAnchors = seatAnchorsRef.current;
  for (const e of session.seatEvents) {
    if (!seatAnchors.has(e.id)) seatAnchors.set(e.id, stream.items.length);
  }
  const seatLinesAt = (i: number): SeatAuditEntry[] =>
    session.seatEvents.filter(
      (e) => Math.min(seatAnchors.get(e.id) ?? Number.MAX_SAFE_INTEGER, stream.items.length) === i,
    );

  // Codex file edits render inline as diff cards (parity with Claude/amp edits,
  // which are already transcript tool_call items). They live in stream.fileChanges
  // rather than stream.items, so anchor each to the point in the transcript where
  // it happened and splice it in at render time — same interleave-by-index shape
  // as the seat-audit lines above.
  const inlineCodexChanges = useMemo(
    () => codexInlineFileChanges(stream),
    [stream.items, stream.fileChanges],
  );
  const codexChangesAt = (i: number) => inlineCodexChanges.filter((a) => a.index === i);

  // Manual expand/collapse overrides; default = open while running. When the
  // result arrives the card auto-collapses only if the view is pinned to the
  // bottom — if the user scrolled up to read it, it stays open under them.
  const [toolOpen, setToolOpen] = useState<Record<string, boolean>>({});
  const toolDefaultsRef = useRef(new Map<string, boolean>());
  const toolDefaultOpen = (item: ToolCallItem): boolean => {
    if (item.result === undefined) return true;
    let d = toolDefaultsRef.current.get(item.id);
    if (d === undefined) {
      d = !stickRef.current;
      toolDefaultsRef.current.set(item.id, d);
    }
    return d;
  };

  // Autoscroll while pinned to the bottom (same pattern as Timeline).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastEventId = stream.lastEventId;
  const seatEventCount = session.seatEvents.length;
  const questionEventCount = questionEvents.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEventId, seatEventCount, questionEventCount]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const focused = layout === 'focus';
  const canDetach = !isPendingSessionId(session.id);

  return (
    <aside
      className={`flex min-w-0 flex-col border-l border-edge bg-surface/60 ${
        focused ? 'flex-1' : 'w-[min(520px,42vw)] shrink-0'
      }`}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3">
        <StatusChip status={displayStatus} stalled={stalled} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg" title={session.title}>
            {session.title}
          </h2>
          <div className="flex items-center gap-1.5 text-3xs text-fg-muted">
            {driverId !== session.spawnedBy && (
              <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
            )}
            <span
              data-testid="driver-chip"
              className={`shrink-0 truncate rounded-full px-1.5 py-px font-medium ${
                isDriver ? 'bg-accent-hover/15 text-accent-text-strong' : 'bg-surface-overlay/80 text-fg-secondary'
              }`}
            >
              driver: {driverName}
            </span>
            {spectators > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="tabular-nums">{spectators} watching</span>
              </>
            )}
            {costUsd > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="tabular-nums">{formatCost(costUsd)}</span>
              </>
            )}
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
            {!connected && !displayTerminal && (
              <span role="status" className="text-warning/80">
                · reconnecting…
              </span>
            )}
          </div>
        </div>
        {(isSpawner || isDriver) && !displayTerminal && (
          <button
            onClick={onCancel}
            title="Cancel this session"
            className={`rounded-md border px-2 py-1 text-2xs font-medium ${
              displayCancelAsk === 'confirm'
                ? 'border-danger-border-strong bg-danger-tint/60 text-danger-text-strong hover:bg-danger-surface/60'
                : 'border-danger-border/60 text-danger hover:bg-danger-tint/40 hover:text-danger-text'
            }`}
          >
            {displayCancelAsk === 'confirm'
              ? 'Confirm cancel'
              : displayCancelAsk === 'failed'
                ? 'Cancel failed — retry'
                : 'Cancel'}
          </button>
        )}
        {canDetach && (
          <a
            href={`/s/${session.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            aria-label="Open session in a new tab"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            <ExternalLinkIcon size={15} />
          </a>
        )}
        {onToggleFocus && (
          <button
            onClick={onToggleFocus}
            title={focused ? 'Collapse to split view' : 'Expand to focus view'}
            aria-label={focused ? 'Collapse to split view' : 'Expand to focus view'}
            aria-pressed={focused}
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            {focused ? <ShrinkIcon size={15} /> : <ExpandIcon size={15} />}
          </button>
        )}
        <button
          onClick={onClose}
          title="Close session pane"
          aria-label="Close session pane"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon />
        </button>
      </header>

      {seatRequest && !displayTerminal && (
        <div
          data-testid="seat-request-banner"
          className="flex shrink-0 items-center gap-2 border-b border-accent-tint/40 bg-accent-tint/30 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate text-fg-body">
            <span className="font-semibold">{seatRequest.displayName}</span> requests the seat
          </span>
          <button
            onClick={() => sessionsApi.grantSeat(session.id, seatRequest.userId).catch(() => {})}
            className="rounded-md bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent hover:bg-accent-hover"
          >
            Grant
          </button>
          <button
            onClick={() =>
              setIgnoredRequests((prev) => new Set(prev).add(seatRequest.userId))
            }
            className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            Ignore
          </button>
        </div>
      )}

      {pendingQuestion && !displayTerminal && (
        <QuestionBanner
          sessionId={session.id}
          pending={pendingQuestion}
          isDriver={isDriver}
          driverName={driverName}
          proposals={questionProposals}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}

      {isEnded && resultText && (
        <div
          data-testid="session-result"
          className="shrink-0 border-b border-edge bg-surface-raised/60 px-4 py-2"
        >
          <div className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Result
          </div>
          <div className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-body">
            {resultText}
          </div>
        </div>
      )}

      {conflictsN > 0 && (
        <button
          data-testid="conflicts-strip"
          onClick={() => onStrip('conflicts')}
          aria-expanded={workTab === 'conflicts'}
          className="flex shrink-0 items-center gap-2 border-b border-danger-edge bg-danger-surface px-3 py-1.5 text-left text-2xs text-danger-text hover:opacity-90"
        >
          <span className="font-semibold uppercase tracking-wider">Conflicts</span>
          <span className="tabular-nums">· {conflictsN}</span>
          <span className="ml-auto opacity-80">{workTab === 'conflicts' ? 'Hide' : 'Resolve'}</span>
        </button>
      )}
      {changedFileCount > 0 && (
        <button
          data-testid="changes-strip"
          onClick={() => onStrip('changes')}
          aria-expanded={workTab === 'changes'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Changes</span>
          <span className="tabular-nums">· {changedFileCount}</span>
          <span className="ml-auto text-fg-tertiary">
            {workTab === 'changes' ? 'Hide' : 'View'}
          </span>
        </button>
      )}
      {sideEffectsN > 0 && (
        <button
          data-testid="sideeffects-strip"
          onClick={() => onStrip('sideEffects')}
          aria-expanded={workTab === 'sideEffects'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Side-effects</span>
          <span className={`tabular-nums ${sideEffectsDanger ? 'text-danger-text' : ''}`}>
            · {sideEffectsN}
          </span>
          <span className="ml-auto text-fg-tertiary">
            {workTab === 'sideEffects' ? 'Hide' : 'View'}
          </span>
        </button>
      )}
      {artifactsN > 0 && (
        <button
          data-testid="artifacts-strip"
          onClick={() => onStrip('artifacts')}
          aria-expanded={workTab === 'artifacts'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Artifacts</span>
          <span className="tabular-nums">· {artifactsN}</span>
          <span className="ml-auto text-fg-tertiary">
            {workTab === 'artifacts' ? 'Hide' : 'View'}
          </span>
        </button>
      )}

      <div className={`flex min-h-0 flex-1 ${workTab && workPinned ? 'flex-row' : 'flex-col'}`}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {workTab && !workPinned && (
          <WorkDrawer
            changes={fileChanges}
            changedFileCount={changedFileCount}
            effects={sideEffects}
            sideEffectCount={sideEffectsN}
            hasDanger={sideEffectsDanger}
            artifacts={artifacts}
            artifactCount={artifactsN}
            conflicts={conflicts}
            conflictCount={conflictsN}
            onResolveConflict={resolveConflict}
            sessionId={session.id}
            tab={workTab}
            onTab={setWorkTab}
            pinned={false}
            onTogglePin={togglePin}
            canDetach={canDetach}
            onClose={closeWork}
          />
        )}
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-2">
        {stream.items.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-fg-muted">
            {!displayTerminal ? (
              <span className="animate-pulse">Waiting for agent output…</span>
            ) : isTerminalExecutionStatus(stream.status) ? (
              'No transcript.'
            ) : (
              'Loading transcript…'
            )}
          </div>
        )}
        {stream.items.map((item, i) => (
          <Fragment key={i}>
            {seatLinesAt(i).map((e) => (
              <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
            ))}
            {codexChangesAt(i).map((a) => (
              <div key={a.change.id} className="pl-3.5">
                <InlineFileChange change={a.change} />
              </div>
            ))}
            {item.type === 'text' ? (
              <div className="pl-3.5">
                <TextBlock item={item} />
              </div>
            ) : item.type === 'user_message' ? (
              <div data-testid="user-steer" data-turn={item.id} className="pt-2 pb-0.5">
                <div className="text-sm font-semibold text-fg">{steerAuthor}</div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">
                  {item.text}
                </div>
              </div>
            ) : item.type === 'question' ? (
              <div className="pl-3.5">
                <QuestionTranscriptCard
                  item={item}
                  events={questionEventsByQuestion.get(item.questionId) ?? []}
                />
              </div>
            ) : (
              <div className="pl-3.5">
                <TranscriptTool
                  item={item}
                  expanded={toolOpen[item.id] ?? toolDefaultOpen(item)}
                  onToggle={() =>
                    setToolOpen((prev) => ({
                      ...prev,
                      [item.id]: !(prev[item.id] ?? toolDefaultOpen(item)),
                    }))
                  }
                />
              </div>
            )}
          </Fragment>
        ))}
        {seatLinesAt(stream.items.length).map((e) => (
          <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
        ))}
        {codexChangesAt(stream.items.length).map((a) => (
          <div key={a.change.id} className="pl-3.5">
            <InlineFileChange change={a.change} />
          </div>
        ))}
        {displayStatus === 'completed' && (resultText || costUsd > 0) && (
          <div
            data-testid="turn-card"
            className="mt-3 rounded-lg border border-edge bg-surface-raised/40 px-3.5 py-3"
          >
            <div className="flex items-center gap-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
              <span>Turn complete</span>
              {(costUsd > 0 || stream.models.length > 0) && (
                <span className="ml-auto flex items-center gap-1.5 font-normal normal-case tracking-normal text-fg-faint">
                  {costUsd > 0 && <span className="tabular-nums">{formatCost(costUsd)}</span>}
                  {costUsd > 0 && stream.models.length > 0 && <span>·</span>}
                  {stream.models.length > 0 && <span>{stream.models.join(', ')}</span>}
                </span>
              )}
            </div>
            {resultText && (
              <div className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-body">
                {resultText}
              </div>
            )}
            <div className="mt-2 text-2xs text-fg-muted">What next? Steer the agent below.</div>
          </div>
        )}
        </div>
        <TurnRail
          turns={turns}
          onJump={(id) =>
            scrollRef.current
              ?.querySelector(`[data-turn="${id}"]`)
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
        />
        </div>
        {workTab && workPinned && (
          <div className="flex min-h-0 w-[min(440px,46%)] shrink-0 flex-col border-l border-edge">
            <WorkDrawer
              changes={fileChanges}
              changedFileCount={changedFileCount}
              effects={sideEffects}
              sideEffectCount={sideEffectsN}
              hasDanger={sideEffectsDanger}
              artifacts={artifacts}
              artifactCount={artifactsN}
              conflicts={conflicts}
              conflictCount={conflictsN}
              onResolveConflict={resolveConflict}
              sessionId={session.id}
              tab={workTab}
              onTab={setWorkTab}
              pinned
              onTogglePin={togglePin}
              canDetach={canDetach}
              onClose={closeWork}
            />
          </div>
        )}
      </div>

      {isEnded ? (
        <div className="shrink-0 border-t border-edge px-4 py-2.5 text-2xs text-fg-muted">
          Session ended — transcript is read-only.
        </div>
      ) : (
        <>
          {pendingSuggestions.length > 0 && (
            <SuggestionStrip
              sessionId={session.id}
              suggestions={pendingSuggestions}
              isDriver={isDriver}
              nameFor={nameFor}
            />
          )}
          {isDriver && steerError && (
            <div
              role="alert"
              data-testid="steer-error"
              className="flex shrink-0 items-center gap-2 border-t border-danger-border/40 bg-danger-tint/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-danger-text">
                Message didn't send: "{steerError}"
              </span>
              <button
                onClick={() => sendSteer(steerError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                onClick={() => {
                  setLocalSteerError(null);
                  onClearFailedSteer();
                }}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          {!isDriver && suggestError && (
            <div
              role="alert"
              data-testid="suggestion-error"
              className="flex shrink-0 items-center gap-2 border-t border-danger-border/40 bg-danger-tint/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-danger-text">
                Suggestion didn't send: "{suggestError}"
              </span>
              <button
                onClick={() => sendSuggestion(suggestError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                onClick={() => setSuggestError(null)}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          <SessionTypingLine typers={typers} />
          <Composer
            placeholder={
              isDriver
                ? 'You have the seat — message this session'
                : `Suggest a message — ${driverName} decides`
            }
            onSend={isDriver ? sendSteer : sendSuggestion}
            onTyping={onComposerTyping}
            footer={
              isDriver ? undefined : (
                <span data-testid="seat-footer" className="flex items-center gap-2">
                  {seatRequested ? (
                    <span>
                      {seatAsk === 'seat-held' && (
                        <span className="text-warning/80">seat held · </span>
                      )}
                      requested — waiting for {driverName}
                    </span>
                  ) : seatAsk === 'confirm-take' ? (
                    <>
                      <span className="text-fg-tertiary">take the seat from {driverName}?</span>
                      <button
                        onClick={takeSeat}
                        className="rounded border border-accent-border-muted/60 px-2 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setSeatAsk('idle')}
                        className="rounded px-2 py-0.5 font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
                      >
                        Keep watching
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={driverPresent ? requestSeat : () => setSeatAsk('confirm-take')}
                      className="rounded border border-accent-border-muted/60 px-2 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
                    >
                      {driverPresent ? 'Request seat' : 'Take seat'}
                    </button>
                  )}
                </span>
              )
            }
          />
        </>
      )}
    </aside>
  );
}

function QuestionBanner({
  sessionId,
  pending,
  isDriver,
  driverName,
  proposals,
  onAnswerQuestion,
}: {
  sessionId: string;
  pending: { questionId: string; questions: QuestionPrompt[] };
  isDriver: boolean;
  driverName: string;
  /** Pending answer proposals for this question (driver decides). */
  proposals: SessionAnswerProposal[];
  onAnswerQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
}) {
  const bannerId = useId();
  const titleId = `${bannerId}-title`;
  const [values, setValues] = useState<Record<string, QuestionDraftValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues({});
    setSubmitting(false);
    setCleared(null);
    setProposed(false);
    setError(null);
  }, [pending.questionId]);
  if (cleared === pending.questionId) return null;

  const setAnswer = (id: string, value: string) => {
    setError(null);
    setValues((prev) => ({ ...prev, [id]: value }));
  };
  const toggleAnswer = (id: string, value: string) => {
    setError(null);
    setValues((prev) => {
      const existing = Array.isArray(prev[id]) ? prev[id] : [];
      return {
        ...prev,
        [id]: existing.includes(value)
          ? existing.filter((selected) => selected !== value)
          : [...existing, value],
      };
    });
  };
  const complete = pending.questions.every((q) => answerValuesForPrompt(q, values[q.id]).length > 0);
  // The driver answers directly; a spectator proposes an answer the driver decides.
  const submit = () => {
    if (!complete || submitting) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pending.questions) answers[q.id] = { answers: answerValuesForPrompt(q, values[q.id]) };
    setSubmitting(true);
    setError(null);
    if (isDriver) {
      onAnswerQuestion(sessionId, pending.questionId, answers)
        .then(() => setCleared(pending.questionId))
        .catch(() => setError("Answer didn't send. Try again."))
        .finally(() => setSubmitting(false));
    } else {
      sessionsApi
        .proposeAnswer(sessionId, pending.questionId, answers, randomId())
        .then(() => setProposed(true))
        .catch(() => setError("Proposal didn't send. Try again."))
        .finally(() => setSubmitting(false));
    }
  };

  return (
    <div
      data-testid="question-banner"
      role="region"
      aria-labelledby={titleId}
      aria-live="polite"
      className="shrink-0 border-b border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs"
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          id={titleId}
          className="rounded-full bg-warning/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide text-warning-text"
        >
          needs input
        </span>
        {!isDriver && (
          <span className="text-fg-tertiary">
            waiting for {driverName} to answer
          </span>
        )}
      </div>
      <div className="space-y-2">
        {pending.questions.map((q, questionIndex) => {
          const promptId = `${bannerId}-prompt-${questionIndex}`;
          const inputId = `${bannerId}-answer-${questionIndex}`;
          const groupName = `${bannerId}-options-${questionIndex}`;
          return (
            <fieldset key={q.id} className="space-y-1" disabled={submitting}>
              <legend className="flex items-center gap-2">
                <span className="rounded bg-surface-overlay px-1.5 py-px text-3xs font-semibold text-fg-secondary">
                  {q.header}
                </span>
                {q.isSecret && <span className="text-3xs text-fg-muted">secret</span>}
              </legend>
              <div
                id={promptId}
                className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg"
              >
                {q.question}
              </div>
              {q.options?.length ? (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {q.options.map((option, optionIndex) => {
                    const promptValue = values[q.id];
                    const selected = q.multiSelect
                      ? Array.isArray(promptValue) && promptValue.includes(option.label)
                      : promptValue === option.label;
                    const optionDescId = `${bannerId}-option-${questionIndex}-${optionIndex}-description`;
                    return (
                      <label
                        key={option.label}
                        title={option.description}
                        className={`min-w-0 cursor-pointer rounded-md border px-2 py-1 text-left text-2xs ${
                          selected
                            ? 'border-warning bg-warning/15 text-warning-text-strong'
                            : 'border-edge-strong bg-surface-raised/70 text-fg-body hover:border-edge-hover'
                        } ${submitting ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={groupName}
                          value={option.label}
                          checked={selected}
                          disabled={submitting}
                          onChange={() =>
                            q.multiSelect ? toggleAnswer(q.id, option.label) : setAnswer(q.id, option.label)
                          }
                          aria-describedby={`${promptId} ${optionDescId}`}
                          className="sr-only"
                        />
                        <span className="block font-semibold">{option.label}</span>
                        <span
                          id={optionDescId}
                          className="block whitespace-normal break-words text-fg-muted"
                        >
                          {option.description}
                        </span>
                        {option.preview && (
                          <QuestionOptionPreview
                            preview={option.preview}
                            format={option.previewFormat}
                            title={`${option.label} preview`}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <>
                  <label htmlFor={inputId} className="sr-only">
                    Answer for {q.header}
                  </label>
                  <input
                    id={inputId}
                    type={q.isSecret ? 'password' : 'text'}
                    disabled={submitting}
                    value={typeof values[q.id] === 'string' ? values[q.id] : ''}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                    aria-describedby={promptId}
                    autoComplete={q.isSecret ? 'off' : undefined}
                    className="w-full rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-warning disabled:opacity-60"
                  />
                </>
              )}
            </fieldset>
          );
        })}
      </div>
      {error && (
        <div
          role="alert"
          className="mt-2 rounded border border-danger-border/50 bg-danger-tint/20 px-2 py-1 text-2xs text-danger-text"
        >
          {error}
        </div>
      )}

      {isDriver && proposals.length > 0 && (
        <div
          data-testid="answer-proposals"
          className="mt-2 space-y-2 border-t border-warning-border/30 pt-2"
        >
          <div className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Proposed answers · {proposals.length}
          </div>
          {proposals.map((p) => (
            <AnswerProposalRow
              key={p.id}
              sessionId={sessionId}
              proposal={p}
              questions={pending.questions}
            />
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        {isDriver ? (
          <button
            onClick={submit}
            disabled={!complete || submitting}
            className="rounded-md bg-warning px-2.5 py-1 text-2xs font-semibold text-surface hover:bg-warning-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Answering…' : 'Submit answer'}
          </button>
        ) : proposed ? (
          <span className="text-2xs text-fg-muted">proposal sent — {driverName} decides</span>
        ) : (
          <button
            onClick={submit}
            disabled={!complete || submitting}
            className="rounded border border-accent-border-muted/60 px-2 py-0.5 text-2xs font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Proposing…' : 'Propose answer'}
          </button>
        )}
      </div>
    </div>
  );
}

type QuestionDraftValue = string | string[];

function answerValuesForPrompt(q: QuestionPrompt, value: QuestionDraftValue | undefined): string[] {
  if (q.options?.length && q.multiSelect) {
    return Array.isArray(value) ? value.filter((answer) => answer.trim().length > 0) : [];
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function QuestionOptionPreview({
  preview,
  format,
  title,
}: {
  preview: string;
  format?: 'markdown' | 'html';
  title: string;
}) {
  if (format === 'html') {
    return (
      <iframe
        sandbox=""
        title={title}
        srcDoc={optionPreviewHtmlDocument(preview)}
        className="pointer-events-none mt-1.5 h-28 w-full rounded border border-edge bg-white"
      />
    );
  }

  return (
    <pre className="mt-1.5 max-h-32 overflow-auto rounded border border-edge bg-surface px-2 py-1.5 text-[11px] leading-snug text-fg-secondary">
      {preview}
    </pre>
  );
}

function optionPreviewHtmlDocument(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline';"><style>html,body{margin:0;padding:0;background:#fff;color:#111;font:12px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}body{padding:8px;overflow:hidden;}*{box-sizing:border-box;}</style></head><body>${fragment}</body></html>`;
}

function AnswerProposalRow({
  sessionId,
  proposal,
  questions,
}: {
  sessionId: string;
  proposal: SessionAnswerProposal;
  questions: QuestionPrompt[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = (action: 'submit' | 'dismiss') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    sessionsApi
      .resolveAnswerProposal(sessionId, proposal.id, action, {}, randomId())
      .catch(() =>
        setError(action === 'submit' ? "Couldn't submit — try again." : "Couldn't dismiss — try again."),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="answer-proposal-row" className="text-xs">
      <div className="leading-relaxed">
        <span className="font-semibold text-fg">{proposal.authorName ?? proposal.authorId}</span>{' '}
        <span className="text-fg-muted">proposes</span>
      </div>
      <div className="mt-0.5 space-y-0.5">
        {questions.map((q) => (
          <div key={q.id} className="break-words text-fg-body">
            <span className="text-fg-muted">{q.header}: </span>
            {(proposal.answers[q.id]?.answers ?? []).join(', ') || '—'}
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          disabled={busy}
          onClick={() => resolve('submit')}
          className="rounded border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-body hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit
        </button>
        <button
          disabled={busy}
          onClick={() => resolve('dismiss')}
          className="rounded px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body disabled:cursor-not-allowed disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-0.5 text-2xs text-danger-text">
          {error}
        </div>
      )}
    </div>
  );
}

// ---- seat audit lines --------------------------------------------------------

function seatLineLabel(e: SeatAuditEntry, nameFor: (id: string | null) => string): string {
  const to = e.toName ?? nameFor(e.to);
  const from = e.from ? (e.fromName ?? nameFor(e.from)) : null;
  return e.reason === 'taken'
    ? `${to} took the seat${from ? ` from ${from}` : ''}`
    : `${from ?? 'the driver'} granted the seat to ${to}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ChatGPT-style turn spine: ticks at the right edge, hover → floating turn list. */
function TurnRail({
  turns,
  onJump,
}: {
  turns: { id: string; text: string }[];
  onJump: (id: string) => void;
}) {
  if (turns.length === 0) return null;
  const shown = turns.slice(-14); // cap to the most recent turns
  return (
    <div data-testid="turn-rail" className="group absolute right-1.5 top-1/2 z-10 -translate-y-1/2">
      <div className="flex flex-col items-end gap-1.5 py-1 transition-opacity group-hover:opacity-0">
        {shown.map((t) => (
          <span key={t.id} className="block h-0.5 w-4 rounded-full bg-fg-faint" />
        ))}
      </div>
      <div className="absolute right-0 top-1/2 hidden -translate-y-1/2 group-hover:block">
        <div className="max-h-[60vh] w-56 overflow-y-auto rounded-lg border border-edge bg-surface-raised py-1 shadow-lg">
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onJump(t.id)}
              className="block w-full truncate px-3 py-1.5 text-left text-xs text-fg-body hover:bg-surface-overlay"
              title={t.text}
            >
              {t.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** "X is composing…" line above the session composer (calm, ephemeral). */
function SessionTypingLine({ typers }: { typers: UserRef[] }) {
  const names = typers.map((u) => u.displayName);
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is composing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are composing…`
          : 'Several people are composing…';
  return (
    <div aria-live="polite" className="h-4 shrink-0 px-4 text-3xs leading-4 text-fg-muted">
      {label}
    </div>
  );
}

// ---- suggestion queue -------------------------------------------------------

/**
 * The suggestion queue: one quiet grouped object above the composer. Visible to
 * everyone (the queue teaches good steers); only the driver gets the Send /
 * Edit / Dismiss actions. Send is an outline button — blue stays scarce.
 */
function SuggestionStrip({
  sessionId,
  suggestions,
  isDriver,
  nameFor,
}: {
  sessionId: string;
  suggestions: SessionSuggestion[];
  isDriver: boolean;
  nameFor: (id: string | null) => string;
}) {
  return (
    <div
      data-testid="suggestion-strip"
      className="shrink-0 border-t border-edge bg-surface-raised/40 px-3 py-2"
    >
      <div className="mb-1.5 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
        Suggestions · {suggestions.length}
      </div>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <SuggestionRow
            key={s.id}
            sessionId={sessionId}
            suggestion={s}
            isDriver={isDriver}
            authorName={s.authorName ?? nameFor(s.authorId)}
          />
        ))}
      </div>
    </div>
  );
}

function SuggestionRow({
  sessionId,
  suggestion,
  isDriver,
  authorName,
}: {
  sessionId: string;
  suggestion: SessionSuggestion;
  isDriver: boolean;
  authorName: string;
}) {
  const [mode, setMode] = useState<'idle' | 'editing' | 'dismissing'>('idle');
  const [draft, setDraft] = useState(suggestion.text);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switch sub-modes and drop any prior resolve error — it no longer describes
  // the visible state.
  const switchMode = (next: 'idle' | 'editing' | 'dismissing') => {
    setMode(next);
    setError(null);
  };

  // On success the row leaves the pending queue and unmounts; reset `busy`
  // either way (via finally) so a dropped/missed resolve event can't strand the
  // row disabled with no way to retry.
  const resolve = (action: 'send' | 'dismiss', opts: { text?: string; note?: string } = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    sessionsApi
      .resolveSuggestion(sessionId, suggestion.id, action, opts, randomId())
      .catch(() =>
        setError(action === 'send' ? "Couldn't send — try again." : "Couldn't dismiss — try again."),
      )
      .finally(() => setBusy(false));
  };

  const outlineBtn =
    'rounded border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-body hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50';
  const quietBtn =
    'rounded px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body';

  return (
    <div data-testid="suggestion-row" className="text-xs">
      <div className="leading-relaxed">
        <span className="font-semibold text-fg">{authorName}</span>{' '}
        {mode !== 'editing' && (
          <span className="whitespace-pre-wrap break-words text-fg-body">{suggestion.text}</span>
        )}
      </div>

      {mode === 'editing' ? (
        <div className="mt-1 space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            aria-label="Edit suggestion"
            className="w-full resize-none rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-edge-focus"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy || draft.trim().length === 0}
              onClick={() => resolve('send', { text: draft })}
              className={outlineBtn}
            >
              Send edited
            </button>
            <button
              onClick={() => {
                switchMode('idle');
                setDraft(suggestion.text);
              }}
              className={quietBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : mode === 'dismissing' ? (
        <div className="mt-1 space-y-1">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="why? (optional)"
            aria-label="Dismiss reason"
            className="w-full rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs text-fg outline-none focus:border-edge-focus"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => resolve('dismiss', note.trim() ? { note: note.trim() } : {})}
              className={outlineBtn}
            >
              Dismiss
            </button>
            <button
              onClick={() => {
                switchMode('idle');
                setNote('');
              }}
              className={quietBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : isDriver ? (
        <div className="mt-0.5 flex items-center gap-2">
          <button disabled={busy} onClick={() => resolve('send')} className={outlineBtn}>
            Send
          </button>
          <button onClick={() => switchMode('editing')} className={quietBtn}>
            Edit
          </button>
          <button onClick={() => switchMode('dismissing')} className={quietBtn}>
            Dismiss
          </button>
        </div>
      ) : null}

      {error && (
        <div role="alert" className="mt-0.5 text-2xs text-danger-text">
          {error}
        </div>
      )}
    </div>
  );
}

function SeatAuditLine({
  entry,
  nameFor,
}: {
  entry: SeatAuditEntry;
  nameFor: (id: string | null) => string;
}) {
  return (
    <div
      data-testid="seat-audit-line"
      className="my-1 flex items-center gap-1.5 text-2xs text-fg-muted"
    >
      <span aria-hidden className="text-fg-faint">
        <ArrowUpIcon size={12} />
      </span>
      <span className="truncate">{seatLineLabel(entry, nameFor)}</span>
      <span className="text-fg-faint">·</span>
      <span className="tabular-nums">{hhmm(entry.at)}</span>
    </div>
  );
}

// ---- transcript items -------------------------------------------------------

function groupQuestionEventsByQuestion(events: SessionQuestionEvent[]): Map<string, SessionQuestionEvent[]> {
  const grouped = new Map<string, SessionQuestionEvent[]>();
  for (const event of events) {
    const current = grouped.get(event.questionId) ?? [];
    current.push(event);
    grouped.set(event.questionId, current);
  }
  for (const [questionId, current] of grouped) {
    grouped.set(questionId, [...current].sort((a, b) => a.id - b.id));
  }
  return grouped;
}

function latestQuestionEvent(
  events: SessionQuestionEvent[],
  kind: SessionQuestionEvent['kind'],
): SessionQuestionEvent | undefined {
  return [...events].reverse().find((event) => event.kind === kind);
}

function answerByPromptId(events: SessionQuestionEvent[]): Map<string, SessionQuestionAnswerSummary> {
  const answered = latestQuestionEvent(events, 'answered');
  const summaries = new Map<string, SessionQuestionAnswerSummary>();
  for (const summary of answered?.answers ?? []) {
    summaries.set(summary.id, summary);
  }
  return summaries;
}

function questionResolutionText(reason: QuestionItem['reason'] | undefined): string {
  if (reason === 'empty') return 'Expired without an answer';
  if (reason === 'cancelled') return 'Cancelled';
  return 'Answered';
}

function questionStatusLabel(
  item: QuestionItem,
  events: SessionQuestionEvent[],
): { label: string; tone: 'pending' | 'answered' | 'cancelled' } {
  const answered = latestQuestionEvent(events, 'answered');
  const resolved = latestQuestionEvent(events, 'resolved');
  const reason = item.reason ?? resolved?.reason ?? (answered ? 'answered' : undefined);
  if (item.status === 'pending' && !answered && !resolved) {
    return { label: 'Waiting for answer', tone: 'pending' };
  }
  if (reason === 'cancelled' || reason === 'empty') {
    return { label: questionResolutionText(reason), tone: 'cancelled' };
  }
  return { label: 'Answered', tone: 'answered' };
}

function answerValueText(summary: SessionQuestionAnswerSummary): string {
  if (summary.answers.length > 0) return summary.answers.join('\n');
  return summary.count === 1 ? '1 answer recorded' : `${summary.count} answers recorded`;
}

function QuestionTranscriptCard({
  item,
  events,
}: {
  item: QuestionItem;
  events: SessionQuestionEvent[];
}) {
  const labelId = useId();
  const requested = latestQuestionEvent(events, 'requested');
  const answered = latestQuestionEvent(events, 'answered');
  const resolved = latestQuestionEvent(events, 'resolved');
  const prompts = item.questions.length > 0 ? item.questions : requested?.questions ?? [];
  const status = questionStatusLabel(item, events);
  const answerSummaries = answerByPromptId(events);
  const statusClass =
    status.tone === 'pending'
      ? 'border-warning-border/50 bg-warning-tint/15 text-warning-text'
      : status.tone === 'cancelled'
        ? 'border-edge bg-surface-overlay/50 text-fg-muted'
        : 'border-accent-border-muted/50 bg-accent-tint/20 text-accent-text-strong';
  const answeredBy = answered?.actorName ?? answered?.actorId;
  const resolvedReason = item.reason ?? resolved?.reason;

  return (
    <article
      style={ITEM_VIS}
      role="group"
      aria-labelledby={labelId}
      data-testid="question-transcript-card"
      className="my-2 rounded-md border border-warning-border/40 bg-warning-tint/10 px-3 py-2 text-xs text-fg-body"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="font-semibold text-fg">
          Agent question
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${statusClass}`}>
          {status.label}
        </span>
        {answered && (
          <span className="text-2xs text-fg-muted">
            {answeredBy ? `by ${answeredBy}` : 'answered'} at {hhmm(answered.at)}
          </span>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {prompts.length > 0 ? (
          prompts.map((question) => {
            const summary = answerSummaries.get(question.id);
            return (
              <section key={question.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-surface-overlay px-1.5 py-px text-3xs font-semibold text-fg-secondary">
                    {question.header}
                  </span>
                  {question.isSecret && <span className="text-3xs text-fg-muted">secret</span>}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
                  {question.question}
                </div>
                {question.options?.length ? (
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {question.options.map((option) => (
                      <li key={option.label} className="rounded border border-edge bg-surface-raised/50 px-2 py-1">
                        <span className="block font-semibold text-fg-secondary">{option.label}</span>
                        <span className="block whitespace-pre-wrap break-words text-2xs text-fg-muted">
                          {option.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {summary && (
                  <div className="rounded border border-accent-border-muted/40 bg-accent-tint/10 px-2 py-1">
                    <div className="text-3xs font-semibold uppercase tracking-wide text-accent-text-strong">
                      Answer
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-fg-body">
                      {answerValueText(summary)}
                    </div>
                  </div>
                )}
              </section>
            );
          })
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm text-fg">
            Agent asked a question.
          </div>
        )}
      </div>

      <details className="mt-2 text-2xs text-fg-muted">
        <summary className="cursor-pointer text-fg-tertiary hover:text-fg-body">
          Show event details
        </summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt>Question id</dt>
          <dd className="break-all font-mono">{item.questionId}</dd>
          {item.turnId && (
            <>
              <dt>Turn id</dt>
              <dd className="break-all font-mono">{item.turnId}</dd>
            </>
          )}
          <dt>Source events</dt>
          <dd className="break-words font-mono">{item.sourceEventIds.join(', ')}</dd>
          {resolvedReason && (
            <>
              <dt>Resolution</dt>
              <dd>{questionResolutionText(resolvedReason)}</dd>
            </>
          )}
        </dl>
      </details>
    </article>
  );
}

const TextBlock = memo(
  function TextBlock({ item }: { item: TextItem }) {
    return (
      <div
        style={ITEM_VIS}
        className="whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-fg-body"
      >
        {item.text}
      </div>
    );
  },
  (prev, next) => prev.item.text === next.item.text,
);

function firstInputLine(item: ToolCallItem): string {
  const command = item.input['command'];
  if (typeof command === 'string' && command) return command.split('\n')[0] ?? '';
  const keys = Object.keys(item.input);
  return keys.length === 0 ? '' : JSON.stringify(item.input).slice(0, 120);
}

/** A transcript tool call: file edits (Edit/Write/MultiEdit/NotebookEdit) render
 * as an inline diff card — the actual change where it happened, not raw JSON —
 * and everything else as the generic tool card. Codex edits arrive as state, not
 * positioned items, so they stay drawer-only. */
function TranscriptTool({
  item,
  expanded,
  onToggle,
}: {
  item: ToolCallItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fileChange = fileChangeFromToolCall(item);
  if (fileChange) {
    const status = item.result === undefined ? 'running' : item.result.is_error ? 'error' : 'done';
    return <InlineFileChange change={fileChange} status={status} />;
  }
  return <ToolCard item={item} expanded={expanded} onToggle={onToggle} />;
}

const ToolCard = memo(
  function ToolCard({
    item,
    expanded,
    onToggle,
  }: {
    item: ToolCallItem;
    expanded: boolean;
    onToggle: () => void;
  }) {
    const running = item.result === undefined;
    const isError = item.result?.is_error === true;
    const command = typeof item.input['command'] === 'string' ? (item.input['command'] as string) : null;
    const rest = Object.fromEntries(Object.entries(item.input).filter(([k]) => k !== 'command'));
    const restJson = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;

    return (
      <div
        style={ITEM_VIS}
        data-testid="tool-card"
        className={`my-1 rounded-md border text-xs ${
          isError ? 'border-danger-border/60 bg-danger-tint/20' : 'border-edge bg-surface-raised/50'
        }`}
      >
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-overlay/40"
        >
          <span className="text-fg-muted">
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
          <span className="shrink-0 font-mono font-semibold text-fg-body">{item.name}</span>
          {!expanded && (
            <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">
              {firstInputLine(item)}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {running ? (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-text" />
            ) : isError ? (
              <span className="font-semibold text-danger">error</span>
            ) : (
              <span className="text-fg-muted">done</span>
            )}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-edge/80 px-2 py-1.5">
            {command !== null && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-secondary">
                {command}
              </pre>
            )}
            {restJson && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-muted">
                {restJson}
              </pre>
            )}
            {item.result && (
              <pre
                className={`mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-2xs leading-relaxed ${
                  isError
                    ? 'border-danger-border/60 bg-danger-tint/30 text-danger-text-strong'
                    : 'border-edge bg-surface/70 text-fg-secondary'
                }`}
              >
                {item.result.content}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  },
  // onToggle is intentionally excluded: it is a fresh closure every render but
  // only reads stable fields (item.id) plus state via a functional update.
  (prev, next) =>
    prev.expanded === next.expanded &&
    prev.item.name === next.item.name &&
    prev.item.input === next.item.input &&
    prev.item.result?.content === next.item.result?.content &&
    prev.item.result?.is_error === next.item.result?.is_error,
);
