import { useId, type CSSProperties } from 'react';
import type { QuestionItem } from '@atrium/centaur-client';
import type { SessionQuestionAnswerSummary, SessionQuestionEvent } from './types';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

export function groupQuestionEventsByQuestion(
  events: SessionQuestionEvent[],
): Map<string, SessionQuestionEvent[]> {
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

function hhmm(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function QuestionTranscriptCard({
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
