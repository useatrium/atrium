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
  isTerminalExecutionStatus,
  type QuestionItem,
  type TextItem,
  type ToolCallItem,
} from '@atrium/centaur-client';
import { ApiError } from '../api';
import { Composer } from '../components/Composer';
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from '../components/icons';
import type { UserRef } from '@atrium/surface-client';
import { formatTime } from '@atrium/surface-client';
import { sessionsApi } from './api';
import { StatusChip, sessionElapsedMs, useNow } from './SessionCard';
import {
  formatCost,
  formatElapsed,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
  sessionDriverId,
  type SeatAuditEntry,
  type QuestionPrompt,
  type Session,
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
  onClose,
  onAnswerQuestion,
  onSteer = async () => {},
  failedSteer = null,
  onClearFailedSteer = () => {},
  onCancelSession = async () => {},
  failedCancel = false,
  onClearFailedCancel = () => {},
}: {
  session: Session;
  me: UserRef;
  /** Presence list for `session:<id>` — everyone with this pane open. */
  watchers: UserRef[];
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
}) {
  const { stream, connected } = useSessionStream(session.id);

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

  return (
    <aside className="flex w-[min(520px,42vw)] shrink-0 flex-col border-l border-edge bg-surface/60">
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
          seatRequested={seatRequested}
          requestSeat={requestSeat}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}

      {displayTerminal && resultText && (
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

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-2">
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
            {item.type === 'text' ? (
              <TextBlock item={item} />
            ) : item.type === 'user_message' ? (
              <div data-testid="user-steer" className="pt-2 pb-0.5">
                <div className="text-sm font-semibold text-fg">{steerAuthor}</div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">
                  {item.text}
                </div>
              </div>
            ) : item.type === 'question' ? (
              <QuestionTranscriptCard
                item={item}
                events={questionEventsByQuestion.get(item.questionId) ?? []}
              />
            ) : (
              <ToolCard
                item={item}
                expanded={toolOpen[item.id] ?? toolDefaultOpen(item)}
                onToggle={() =>
                  setToolOpen((prev) => ({
                    ...prev,
                    [item.id]: !(prev[item.id] ?? toolDefaultOpen(item)),
                  }))
                }
              />
            )}
          </Fragment>
        ))}
        {seatLinesAt(stream.items.length).map((e) => (
          <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
        ))}
      </div>

      {isEnded ? (
        <div className="shrink-0 border-t border-edge px-4 py-2.5 text-2xs text-fg-muted">
          Session ended — transcript is read-only.
        </div>
      ) : (
        <>
          {steerError && (
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
          <Composer
            placeholder={
              isDriver ? 'You have the seat — message this session' : 'Message this session'
            }
            onSend={sendSteer}
            disabled={!isDriver}
            disabledHint={`spectating — ${driverName} has the seat`}
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
  seatRequested,
  requestSeat,
  onAnswerQuestion,
}: {
  sessionId: string;
  pending: { questionId: string; questions: QuestionPrompt[] };
  isDriver: boolean;
  driverName: string;
  seatRequested: boolean;
  requestSeat: () => void;
  onAnswerQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
}) {
  const bannerId = useId();
  const titleId = `${bannerId}-title`;
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues({});
    setSubmitting(false);
    setCleared(null);
    setError(null);
  }, [pending.questionId]);
  if (cleared === pending.questionId) return null;

  const setAnswer = (id: string, value: string) => {
    setError(null);
    setValues((prev) => ({ ...prev, [id]: value }));
  };
  const complete = pending.questions.every((q) => (values[q.id] ?? '').trim().length > 0);
  const submit = () => {
    if (!complete || submitting) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pending.questions) answers[q.id] = { answers: [values[q.id]!.trim()] };
    setSubmitting(true);
    setError(null);
    onAnswerQuestion(sessionId, pending.questionId, answers)
      .then(() => setCleared(pending.questionId))
      .catch(() => setError("Answer didn't send. Try again."))
      .finally(() => setSubmitting(false));
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
            <fieldset key={q.id} className="space-y-1" disabled={!isDriver || submitting}>
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
                    const selected = values[q.id] === option.label;
                    const optionDescId = `${bannerId}-option-${questionIndex}-${optionIndex}-description`;
                    return (
                      <label
                        key={option.label}
                        title={option.description}
                        className={`min-w-0 cursor-pointer rounded-md border px-2 py-1 text-left text-2xs ${
                          selected
                            ? 'border-warning bg-warning/15 text-warning-text-strong'
                            : 'border-edge-strong bg-surface-raised/70 text-fg-body hover:border-edge-hover'
                        } ${!isDriver || submitting ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <input
                          type="radio"
                          name={groupName}
                          value={option.label}
                          checked={selected}
                          disabled={!isDriver || submitting}
                          onChange={() => setAnswer(q.id, option.label)}
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
                    disabled={!isDriver || submitting}
                    value={values[q.id] ?? ''}
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
      <div className="mt-2 flex items-center justify-between gap-2">
        {isDriver ? (
          <button
            onClick={submit}
            disabled={!complete || submitting}
            className="rounded-md bg-warning px-2.5 py-1 text-2xs font-semibold text-surface hover:bg-warning-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Answering…' : 'Submit answer'}
          </button>
        ) : seatRequested ? (
          <span className="text-2xs text-fg-muted">seat requested</span>
        ) : (
          <button
            onClick={requestSeat}
            className="rounded border border-accent-border-muted/60 px-2 py-0.5 text-2xs font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
          >
            Request seat
          </button>
        )}
      </div>
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
