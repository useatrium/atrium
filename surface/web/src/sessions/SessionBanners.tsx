import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentProfileProposal } from '../api';
import { formatRelativeTimestamp, formatWaiting, randomId } from '@atrium/surface-client';
import { sessionsApi } from './api';
import {
  getScheduledAnswer,
  releaseAnswer,
  type ScheduledAnswer,
  scheduleAnswer,
  subscribeScheduledAnswers,
  undoAnswer,
} from './pendingAnswers';
import type {
  QuestionPrompt,
  SessionAnsweredQuestion,
  SessionAnswerProposal,
  SessionPendingQuestion,
  SessionProviderAuthRequired,
} from './types';

export function ProfileChangesBanner({
  proposals,
  busyKey,
  error,
  onAction,
}: {
  proposals: AgentProfileProposal[];
  busyKey: string | null;
  error: string | null;
  onAction: (
    proposal: AgentProfileProposal,
    action: 'discard' | 'lineage' | 'save-current' | 'save-new',
  ) => Promise<void>;
}) {
  const proposal = proposals[0]!;
  const settingsCount = Object.keys(proposal.proposal.manifest.settings ?? {}).length;
  const mcpCount = Object.keys(proposal.proposal.manifest.mcpServers ?? {}).length;
  const bundleCount = proposal.proposal.manifest.bundles?.length ?? 0;
  const excludedCount = proposal.proposal.manifest.excluded?.length ?? 0;
  const disabled = busyKey != null;

  return (
    <section
      data-testid="profile-changes-banner"
      aria-label="Agent profile changes"
      className="shrink-0 border-b border-edge bg-surface-raised/80 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-accent-hover/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide text-accent-text-strong">
          profile changes
        </span>
        <span className="min-w-0 flex-1 text-fg-body">
          {profileProviderLabel(proposal.provider)} proposed {settingsCount} settings, {mcpCount} MCP servers,{' '}
          {bundleCount} bundles
          {excludedCount > 0 ? `; ${excludedCount} excluded` : ''}
          {proposal.riskSummary.blockedSecrets > 0
            ? `; ${proposal.riskSummary.blockedSecrets} secret-shaped values blocked`
            : ''}
        </span>
      </div>
      {error && (
        <div role="alert" className="mt-1 text-2xs text-danger-text">
          {error}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <ProfileActionButton
          label="Discard"
          disabled={disabled}
          busy={busyKey === `${proposal.id}:discard`}
          onClick={() => onAction(proposal, 'discard')}
        />
        <ProfileActionButton
          label="Apply lineage"
          disabled={disabled}
          busy={busyKey === `${proposal.id}:lineage`}
          onClick={() => onAction(proposal, 'lineage')}
        />
        <ProfileActionButton
          label="Save profile"
          disabled={disabled}
          busy={busyKey === `${proposal.id}:save-current`}
          onClick={() => onAction(proposal, 'save-current')}
        />
        <ProfileActionButton
          label="Save as new"
          disabled={disabled}
          busy={busyKey === `${proposal.id}:save-new`}
          onClick={() => onAction(proposal, 'save-new')}
        />
        {proposals.length > 1 && (
          <span className="px-1.5 py-1 text-2xs text-fg-muted">{proposals.length - 1} more pending</span>
        )}
      </div>
    </section>
  );
}

function ProfileActionButton({
  label,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-edge px-2 py-1 text-2xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Saving...' : label}
    </button>
  );
}

export function profileProviderLabel(provider: AgentProfileProposal['provider']): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

export function ProviderAuthBanner({
  required,
  isOwner,
  ownerName,
  connected,
  onConnect,
  onResume,
}: {
  required: SessionProviderAuthRequired;
  isOwner: boolean;
  ownerName: string;
  connected: boolean;
  onConnect: () => void;
  onResume?: () => void;
}) {
  return (
    <section
      data-testid="provider-auth-banner"
      aria-label={`${providerLabel(required.provider)} authentication required`}
      className="shrink-0 border-b border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide text-warning-text">
          needs auth
        </span>
        <span className="min-w-0 flex-1 text-fg-body">
          {isOwner
            ? connected
              ? `${providerLabel(required.provider)} is connected. Send a steer to retry this session.`
              : required.message
            : `Waiting for ${ownerName} to reconnect ${providerLabel(required.provider)}.`}
        </span>
        {isOwner && (
          <div className="flex shrink-0 items-center gap-1.5">
            {connected && onResume && (
              <button
                type="button"
                onClick={onResume}
                className="rounded-md bg-accent px-2 py-1 text-2xs font-semibold text-on-accent hover:bg-accent-hover"
              >
                Continue session
              </button>
            )}
            <button
              type="button"
              onClick={onConnect}
              className="rounded-md border border-edge-strong px-2 py-1 text-2xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            >
              {connected ? 'Reconnect' : providerAuthActionLabel(required.provider)}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function providerLabel(provider: SessionProviderAuthRequired['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'github') return 'GitHub';
  return 'Claude Code';
}

function providerActionLabel(provider: SessionProviderAuthRequired['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'github') return 'GitHub';
  return 'Claude';
}

function providerAuthActionLabel(provider: SessionProviderAuthRequired['provider']): string {
  if (provider === 'github') return 'Reconnect GitHub';
  return `Connect ${providerActionLabel(provider)}`;
}

/** Live view of the scheduled (undoable) answer for this question, if any. */
function useScheduledAnswer(sessionId: string, questionId: string): ScheduledAnswer | undefined {
  const snapshot = useCallback(() => getScheduledAnswer(sessionId, questionId), [sessionId, questionId]);
  return useSyncExternalStore(subscribeScheduledAnswers, snapshot, snapshot);
}

/** Whole seconds left on the undo window; ticks only while one is open. */
function useUndoSecondsLeft(scheduled: ScheduledAnswer | undefined): number {
  const open = scheduled?.status === 'scheduled';
  const submitAt = scheduled?.submitAt ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [open]);
  if (!open) return 0;
  return Math.max(0, Math.ceil((submitAt - now) / 1000));
}

/** What the driver picked, for the "Answered: …" line. Secrets never echo. */
function answerLabel(questions: QuestionPrompt[], answers: Record<string, { answers: string[] }>): string {
  const parts: string[] = [];
  for (const q of questions) {
    for (const value of answers[q.id]?.answers ?? []) parts.push(q.isSecret ? 'redacted' : value);
  }
  return parts.join(', ');
}

/**
 * THE canonical answerable question — one design, rendered by reference at
 * every full altitude (feed card flip, thread root, pane banner). Answering
 * any instance resolves them all (they share the session's pendingQuestion).
 * Compact surfaces (rail, Attention) point here instead of re-rendering it.
 *
 * It owns both halves of the question's life: the live form (with the driver's
 * 5s undo window) and, once the question resolves, the durable "who answered
 * what" trace. Callers render it whenever there is a question OR an answer.
 */
export function QuestionCard({
  sessionId,
  pending,
  answered,
  isDriver,
  driverName,
  proposals,
  onAnswerQuestion,
  variant = 'banner',
}: {
  sessionId: string;
  /** Null/absent once the question resolves — the card flips to the trace. */
  pending?: SessionPendingQuestion | null;
  /** Who answered the session's most recent question, and with what. */
  answered?: SessionAnsweredQuestion | null;
  isDriver: boolean;
  driverName: string;
  /** Pending answer proposals for this question (driver decides). */
  proposals: SessionAnswerProposal[];
  /** Optimistic pane path; card surfaces default to the direct API call. */
  onAnswerQuestion?: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  /** banner = pane top strip; card = rounded in-conversation card. */
  variant?: 'banner' | 'card';
}) {
  const bannerId = useId();
  const titleId = `${bannerId}-title`;
  const questionId = pending?.questionId ?? '';
  const [values, setValues] = useState<Record<string, QuestionDraftValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [proposed, setProposed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduled = useScheduledAnswer(sessionId, questionId);
  const undoSecondsLeft = useUndoSecondsLeft(scheduled);
  useEffect(() => {
    setValues({});
    setSubmitting(false);
    setProposed(false);
    setError(null);
  }, [questionId]);

  // The question stopped being pending. If our answer is what resolved it the
  // schedule is already spent; if it resolved *without* us (another user
  // answered, the agent gave up) a still-scheduled answer must be cancelled
  // rather than posted into a dead question.
  const previousQuestionId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousQuestionId.current;
    previousQuestionId.current = questionId || null;
    if (previous && previous !== questionId) releaseAnswer(sessionId, previous);
  }, [questionId, sessionId]);

  if (!pending) {
    return answered ? <AnsweredQuestionTrace trace={answered} variant={variant} /> : null;
  }

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
        [id]: existing.includes(value) ? existing.filter((selected) => selected !== value) : [...existing, value],
      };
    });
  };
  const complete = pending.questions.every((q) => answerValuesForPrompt(q, values[q.id]).length > 0);
  // The driver answers directly; a spectator proposes an answer the driver decides.
  const submit = () => {
    if (!complete || submitting) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pending.questions) answers[q.id] = { answers: answerValuesForPrompt(q, values[q.id]) };
    setError(null);
    if (isDriver) {
      // Scheduled, not posted: the driver gets ANSWER_UNDO_MS to take it back.
      // A second answer inside the window simply replaces this one.
      scheduleAnswer({
        sessionId,
        questionId: pending.questionId,
        answers,
        label: answerLabel(pending.questions, answers),
        ...(onAnswerQuestion ? { submit: onAnswerQuestion } : {}),
      });
      return;
    }
    setSubmitting(true);
    sessionsApi
      .proposeAnswer(sessionId, pending.questionId, answers, randomId())
      .then(() => setProposed(true))
      .catch(() => setError("Proposal didn't send. Try again."))
      .finally(() => setSubmitting(false));
  };

  const errorId = `${bannerId}-error`;

  // A scheduled/sending/sent answer takes over the card body: the options are
  // gone, the answer is stated, and Undo is the only move left.
  if (scheduled && scheduled.status !== 'failed') {
    return (
      <ScheduledAnswerStrip
        scheduled={scheduled}
        secondsLeft={undoSecondsLeft}
        variant={variant}
        onUndo={() => undoAnswer(sessionId, scheduled.questionId)}
      />
    );
  }
  // The delayed post failed (it may well have failed after the card unmounted)
  // — the form comes back with everything intact so the answer can be re-sent.
  const shownError = error ?? (scheduled?.status === 'failed' ? "Answer didn't send. Try again." : null);

  const askedAgo = pending.askedAt ? formatWaiting(Date.now() - new Date(pending.askedAt).getTime()) : null;
  return (
    <section
      data-testid="question-banner"
      aria-labelledby={titleId}
      aria-describedby={shownError ? errorId : undefined}
      aria-busy={submitting ? 'true' : undefined}
      aria-live="polite"
      className={
        variant === 'card'
          ? 'mt-1.5 rounded-md border border-warning-border/50 bg-warning-tint/15 px-2.5 py-2 text-xs'
          : 'shrink-0 border-b border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs'
      }
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          id={titleId}
          className="rounded-full bg-warning/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide text-warning-text"
        >
          {variant === 'card' ? 'question · blocks the run' : 'needs input'}
        </span>
        {askedAgo && askedAgo !== 'just now' && <span className="text-3xs text-fg-muted">asked {askedAgo} ago</span>}
        {!isDriver && <span className="text-fg-tertiary">waiting for {driverName} to answer</span>}
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
              <div id={promptId} className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
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
                        <span id={optionDescId} className="block whitespace-normal break-words text-fg-muted">
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
                  {!q.multiSelect && (
                    <label
                      className={`flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-2xs sm:col-span-2 ${
                        typeof values[q.id] === 'string' &&
                        values[q.id] !== '' &&
                        !q.options.some((o) => o.label === values[q.id])
                          ? 'border-warning bg-warning/15 text-warning-text-strong'
                          : 'border-dashed border-edge-strong text-fg-muted'
                      }`}
                    >
                      <span className="shrink-0">something else:</span>
                      <input
                        type="text"
                        disabled={submitting}
                        value={
                          typeof values[q.id] === 'string' && !q.options.some((o) => o.label === values[q.id])
                            ? (values[q.id] as string)
                            : ''
                        }
                        onChange={(e) => setAnswer(q.id, e.target.value)}
                        placeholder="type it…"
                        className="min-w-0 flex-1 bg-transparent text-2xs text-fg outline-none placeholder:text-fg-faint"
                      />
                    </label>
                  )}
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
      {shownError && (
        <div
          id={errorId}
          role="alert"
          className="mt-2 rounded border border-danger-border/50 bg-danger-tint/20 px-2 py-1 text-2xs text-danger-text"
        >
          {shownError}
        </div>
      )}

      {isDriver && proposals.length > 0 && (
        <div data-testid="answer-proposals" className="mt-2 space-y-2 border-t border-warning-border/30 pt-2">
          <div className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Proposed answers · {proposals.length}
          </div>
          {proposals.map((proposal) => (
            <AnswerProposalRow
              key={proposal.id}
              sessionId={sessionId}
              proposal={proposal}
              questions={pending.questions}
            />
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        {isDriver ? (
          <button
            type="button"
            onClick={submit}
            disabled={!complete || submitting}
            className="rounded-md bg-warning px-2.5 py-1 text-2xs font-semibold text-surface hover:bg-warning-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Answering…' : 'Answer'}
          </button>
        ) : proposed ? (
          <span className="text-2xs text-fg-muted">proposal sent — {driverName} decides</span>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!complete || submitting}
            className="rounded border border-accent-border-muted/60 px-2 py-0.5 text-2xs font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Proposing…' : 'Propose answer'}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The answer is committed but not yet posted. One line, one verb: Undo. The
 * countdown is honest — when it hits zero the answer really does go.
 */
function ScheduledAnswerStrip({
  scheduled,
  secondsLeft,
  variant,
  onUndo,
}: {
  scheduled: ScheduledAnswer;
  secondsLeft: number;
  variant: 'banner' | 'card';
  onUndo: () => void;
}) {
  const undoable = scheduled.status === 'scheduled';
  return (
    <section
      data-testid="question-scheduled-answer"
      aria-live="polite"
      aria-label="Answer scheduled"
      className={
        variant === 'card'
          ? 'mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-warning-border/50 bg-warning-tint/15 px-2.5 py-2 text-xs'
          : 'flex shrink-0 flex-wrap items-center gap-2 border-b border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs'
      }
    >
      <span className="min-w-0 flex-1 text-fg-body">
        <span className="font-semibold text-fg">Answered:</span> <span className="break-words">{scheduled.label}</span>
      </span>
      {undoable ? (
        <button
          type="button"
          data-testid="question-undo"
          onClick={onUndo}
          className="shrink-0 rounded-md border border-edge-strong px-2 py-1 text-2xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
        >
          Undo ({secondsLeft}s)
        </button>
      ) : (
        <span className="shrink-0 text-2xs text-fg-muted">sending…</span>
      )}
    </section>
  );
}

/**
 * The durable record the question leaves behind: who answered, what they
 * picked, when. Same component on the feed card, the thread, and the pane, so
 * "the 2am approval" always has a name on it.
 */
export function AnsweredQuestionTrace({
  trace,
  variant = 'card',
}: {
  trace: SessionAnsweredQuestion;
  variant?: 'banner' | 'card';
}) {
  return (
    <section
      data-testid="question-answered-trace"
      aria-label="Answered question"
      className={
        variant === 'card'
          ? 'mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-edge bg-surface-raised/60 px-2.5 py-1.5 text-2xs'
          : 'flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-edge bg-surface-raised/70 px-3 py-1.5 text-2xs'
      }
    >
      <span aria-hidden="true" className="font-semibold text-accent-text-strong">
        ✓
      </span>
      <span className="text-fg-body">
        Answered by <span className="font-semibold text-fg">{trace.answeredByName}</span>
      </span>
      <span className="text-fg-faint">·</span>
      <span className="min-w-0 break-words font-medium text-fg-secondary">{trace.answerText}</span>
      <span className="text-fg-faint">·</span>
      <span className="tabular-nums text-fg-muted">{formatRelativeTimestamp(trace.at)}</span>
    </section>
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
    <pre className="mt-1.5 max-h-32 overflow-auto rounded border border-edge bg-surface px-2 py-1.5 text-2xs leading-snug text-fg-secondary">
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
      .catch(() => setError(action === 'submit' ? "Couldn't submit — try again." : "Couldn't dismiss — try again."))
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
          type="button"
          disabled={busy}
          onClick={() => resolve('submit')}
          className="rounded border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-body hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit
        </button>
        <button
          type="button"
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
