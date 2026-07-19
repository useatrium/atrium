import { useCallback, useMemo, useRef, useState } from 'react';
import type { Channel, SessionQuestionAnswers } from '@atrium/surface-client';
import { SegmentedControl } from '../components/ui';
import { useDialog } from '../useDialog';
import { GlanceChip } from './GlanceChip';
import { sessionAttentionKind, sessionDriverId, type Session } from './types';
import { agentDockGroups } from './useAgentDock';

export type AgentAttentionViewProps = {
  sessions: Record<string, Session>;
  channels: Channel[];
  onFocusAgent: (id: string) => void;
  onRetryTurn: (sessionId: string) => void | Promise<void>;
  onAnswerQuestion: (sessionId: string, questionId: string, answers: SessionQuestionAnswers) => void | Promise<void>;
};

type AttentionFilter = 'all' | 'blocked' | 'failed';
type AttentionKind = NonNullable<ReturnType<typeof sessionAttentionKind>>;

const REASON_ORDER: AttentionKind[] = ['question', 'authentication', 'seat-request', 'failed'];

const REASON_LABELS: Record<AttentionKind, string> = {
  question: 'Blocked questions',
  authentication: 'Provider authentication',
  'seat-request': 'Seat requests',
  failed: 'Failed',
};

function waitingDetail(session: Session, kind: AttentionKind): string {
  if (kind === 'question') {
    const questions = session.pendingQuestion?.questions ?? [];
    if (questions.length === 0) return 'The agent is waiting for your answer.';
    const first = questions[0]?.question ?? 'The agent is waiting for your answer.';
    return questions.length > 1 ? `${first} · ${questions.length - 1} more` : first;
  }
  if (kind === 'authentication') {
    return session.providerAuthRequired?.message ?? 'Reconnect the provider to continue.';
  }
  if (kind === 'seat-request') {
    const names = session.pendingSeatRequests.map((request) => request.displayName);
    if (names.length === 0) return 'A collaborator requested control of this agent.';
    if (names.length === 1) return `${names[0]} requested control of this agent.`;
    return `${names[0]} and ${names.length - 1} more requested control of this agent.`;
  }
  return session.resultText?.trim() || 'The agent stopped with an error.';
}

function driverName(session: Session): string | null {
  const driverId = sessionDriverId(session);
  if (driverId === session.driverId && session.driverName) return session.driverName;
  if (driverId === session.spawnedBy && session.spawnerName) return session.spawnerName;
  return null;
}

function matchesFilter(kind: AttentionKind, filter: AttentionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'failed') return kind === 'failed';
  return kind !== 'failed';
}

export function AgentAttentionView({
  sessions,
  channels,
  onFocusAgent,
  onRetryTurn,
  onAnswerQuestion,
}: AgentAttentionViewProps) {
  const [filter, setFilter] = useState<AttentionFilter>('all');
  const [multiSelections, setMultiSelections] = useState<Record<string, string[]>>({});
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const needsYou =
    agentDockGroups(sessions, { now: Date.now() }).find((group) => group.kind === 'needs')?.sessions ?? [];
  const rows = needsYou
    .map((session) => ({ session, kind: sessionAttentionKind(session) }))
    .filter((row): row is { session: Session; kind: AttentionKind } => row.kind != null);
  const visibleRows = rows.filter((row) => matchesFilter(row.kind, filter));

  return (
    <section data-testid="agent-attention" className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 border-b border-edge bg-surface/95 px-4 py-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wide text-warning-text">Needs you</p>
            <h1 className="mt-0.5 text-lg font-bold text-fg">Agent attention</h1>
            <p className="mt-1 text-xs text-fg-muted">
              {rows.length === 1 ? '1 agent is waiting for you.' : `${rows.length} agents are waiting for you.`}
            </p>
          </div>
          <SegmentedControl
            aria-label="Filter agent attention"
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'blocked', label: 'Blocked' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-4 py-5">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-edge px-4 py-12 text-center">
            <p className="text-sm font-semibold text-fg">No agents need you.</p>
            <p className="mt-1 text-xs text-fg-muted">Agents that need a decision or recovery step will appear here.</p>
          </div>
        ) : visibleRows.length === 0 ? (
          <p className="py-12 text-center text-sm text-fg-muted">No agents match this filter.</p>
        ) : (
          <div className="space-y-6">
            {REASON_ORDER.map((kind) => {
              const groupedRows = visibleRows.filter((row) => row.kind === kind);
              if (groupedRows.length === 0) return null;
              return (
                <section key={kind} aria-labelledby={`attention-${kind}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <h2
                      id={`attention-${kind}`}
                      className="text-xs font-bold uppercase tracking-wide text-fg-secondary"
                    >
                      {REASON_LABELS[kind]}
                    </h2>
                    <span className="text-xs tabular-nums text-fg-muted">{groupedRows.length}</span>
                  </div>
                  <ul className="overflow-hidden rounded-lg border border-edge bg-surface-raised shadow-sm">
                    {groupedRows.map(({ session, kind }) => {
                      const question = kind === 'question' ? session.pendingQuestion?.questions[0] : undefined;
                      const selectionKey = question
                        ? `${session.id}:${session.pendingQuestion?.questionId}:${question.id}`
                        : '';
                      const selectedOptions = multiSelections[selectionKey] ?? [];
                      const name = driverName(session);
                      return (
                        <li key={session.id} className="border-b border-edge last:border-b-0">
                          <div className="flex flex-wrap items-start gap-4 px-4 py-3.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <GlanceChip session={session} />
                                <h3 className="min-w-0 truncate text-sm font-semibold text-fg">{session.title}</h3>
                                <span className="truncate text-xs text-fg-muted">
                                  #{channelNames.get(session.channelId) ?? session.channelId}
                                </span>
                                {name && <span className="truncate text-xs text-fg-muted">Driver: {name}</span>}
                              </div>
                              <p className="mt-2 line-clamp-2 text-sm leading-5 text-fg-body">
                                {waitingDetail(session, kind)}
                              </p>
                            </div>
                            <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
                              {question?.options?.map((option) => (
                                <button
                                  key={option.label}
                                  type="button"
                                  title={option.description}
                                  aria-pressed={
                                    question.multiSelect ? selectedOptions.includes(option.label) : undefined
                                  }
                                  onClick={() => {
                                    if (question.multiSelect) {
                                      setMultiSelections((current) => {
                                        const selected = current[selectionKey] ?? [];
                                        return {
                                          ...current,
                                          [selectionKey]: selected.includes(option.label)
                                            ? selected.filter((label) => label !== option.label)
                                            : [...selected, option.label],
                                        };
                                      });
                                      return;
                                    }
                                    onAnswerQuestion(session.id, session.pendingQuestion!.questionId, {
                                      [question.id]: { answers: [option.label] },
                                    });
                                  }}
                                  className="rounded-full border border-warning-border/50 bg-warning-tint/15 px-2.5 py-1.5 text-xs font-semibold text-warning-text hover:border-warning hover:bg-warning/15 aria-pressed:border-warning aria-pressed:bg-warning/20"
                                >
                                  {option.label}
                                </button>
                              ))}
                              {question?.multiSelect && question.options?.length ? (
                                <button
                                  type="button"
                                  aria-disabled={selectedOptions.length === 0 || undefined}
                                  onClick={() => {
                                    if (selectedOptions.length === 0) return;
                                    onAnswerQuestion(session.id, session.pendingQuestion!.questionId, {
                                      [question.id]: { answers: selectedOptions },
                                    });
                                  }}
                                  className="rounded-md bg-warning px-2.5 py-1.5 text-xs font-semibold text-surface hover:bg-warning/85 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                                >
                                  Submit answer
                                </button>
                              ) : null}
                              {kind === 'failed' && (
                                <button
                                  type="button"
                                  onClick={() => onRetryTurn(session.id)}
                                  className="rounded-md bg-danger px-2.5 py-1.5 text-xs font-semibold text-surface hover:bg-danger/85"
                                >
                                  Retry turn
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onFocusAgent(session.id)}
                                className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-accent-text hover:bg-accent-hover/10"
                              >
                                Open →
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function AgentAttentionDialog({ onClose, ...viewProps }: AgentAttentionViewProps & { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = useCallback(() => onCloseRef.current(), []);

  useDialog({
    open: true,
    containerRef,
    initialFocusRef: closeButtonRef,
    onClose: handleClose,
  });

  return (
    <div className="fixed inset-0 z-overlay flex bg-surface/80 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Agent attention"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-2xl"
      >
        <div className="flex justify-end border-b border-edge p-2">
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg"
          >
            Close
          </button>
        </div>
        <AgentAttentionView {...viewProps} />
      </div>
    </div>
  );
}
