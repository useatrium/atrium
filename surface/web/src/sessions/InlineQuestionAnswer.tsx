import { useState } from 'react';
import { randomId } from '@atrium/surface-client';
import { sessionsApi } from './api';
import type { Session } from './types';

/**
 * The one answer surface for a pending agent question: option buttons plus a
 * free-text field. Drivers answer; everyone else's submission files a
 * suggestion the driver can accept. Rendered wherever the question appears —
 * the session thread's question card, the feed/rail session card while the
 * question is live, and the Attention row — so people act where they are
 * instead of being sent to the pane.
 */
export function InlineQuestionAnswer({ session, meId }: { session: Session; meId?: string }) {
  const pending = session.pendingQuestion;
  const question = pending?.questions[0];
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pending || !question) return null;
  const isDriver = session.driverId === meId;
  const submit = (value: string) => {
    const answer = value.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    const answers = { [question.id]: { answers: [answer] } };
    const request = isDriver
      ? sessionsApi.answerQuestion(session.id, pending.questionId, answers, randomId())
      : sessionsApi.createSuggestion(session.id, answer, randomId(), true);
    request
      .then(() => {
        setSent(true);
        setDraft('');
      })
      .catch(() => setError(isDriver ? "Answer didn't send. Try again." : "Suggestion didn't send. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="inline-question-answer" className="mt-2 border-t border-warning-border/30 pt-2">
      {question.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy || sent}
              title={option.description}
              onClick={() => submit(option.label)}
              className="rounded-md border border-warning-border/60 bg-warning-tint/15 px-2 py-1 text-2xs font-medium text-warning-text-strong hover:bg-warning-tint/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-1.5 flex min-w-0 gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <label className="sr-only" htmlFor={`inline-answer-${session.id}-${pending.questionId}`}>
          {isDriver ? 'Type an answer' : 'Suggest an answer'}
        </label>
        <input
          id={`inline-answer-${session.id}-${pending.questionId}`}
          value={draft}
          disabled={busy || sent}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={isDriver ? 'type an answer…' : 'Suggest an answer…'}
          className="min-w-0 flex-1 rounded-md border border-warning-border/50 bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-fg-muted focus:border-warning disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy || sent}
          className="shrink-0 rounded-md bg-warning px-2 py-1 text-2xs font-semibold text-surface hover:bg-warning-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Sending…' : isDriver ? 'Answer' : 'Suggest'}
        </button>
      </form>
      {!isDriver && !sent && (
        <div className="mt-1 text-3xs text-fg-muted">The current driver decides what to send.</div>
      )}
      {sent && <div className="mt-1 text-3xs text-fg-muted">{isDriver ? 'Answer sent.' : 'Suggestion sent.'}</div>}
      {error && (
        <div role="alert" className="mt-1 text-3xs text-danger-text">
          {error}
        </div>
      )}
    </div>
  );
}
