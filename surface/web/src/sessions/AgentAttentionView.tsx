import { useState } from 'react';
import { GlanceChip } from './GlanceChip';
import { sessionAttentionKind, type Session } from './types';
import { agentDockGroups } from './useAgentDock';

export type AgentAttentionViewProps = {
  sessions: Record<string, Session>;
  onFocusAgent: (id: string) => void;
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

const ACTION_LABELS: Record<AttentionKind, string> = {
  question: 'Answer →',
  authentication: 'Reconnect →',
  'seat-request': 'Review →',
  failed: 'Retry →',
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

function matchesFilter(kind: AttentionKind, filter: AttentionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'failed') return kind === 'failed';
  return kind !== 'failed';
}

export function AgentAttentionView({ sessions, onFocusAgent }: AgentAttentionViewProps) {
  const [filter, setFilter] = useState<AttentionFilter>('all');
  const needsYou =
    agentDockGroups(sessions, { now: Date.now() }).find((group) => group.kind === 'needs')?.sessions ?? [];
  const rows = needsYou
    .map((session) => ({ session, kind: sessionAttentionKind(session) }))
    .filter((row): row is { session: Session; kind: AttentionKind } => row.kind != null);
  const visibleRows = rows.filter((row) => matchesFilter(row.kind, filter));

  return (
    <section data-testid="agent-attention" className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 border-b border-edge bg-surface/95 px-5 py-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wide text-warning-text">Needs you</p>
            <h1 className="mt-0.5 text-lg font-bold text-fg">Agent attention</h1>
            <p className="mt-1 text-xs text-fg-muted">
              {rows.length === 1 ? '1 agent is waiting for you.' : `${rows.length} agents are waiting for you.`}
            </p>
          </div>
          <fieldset
            aria-label="Filter agent attention"
            className="flex items-center gap-1 rounded-lg bg-surface-overlay p-1"
          >
            {(['all', 'blocked', 'failed'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filter === value
                    ? 'bg-surface-raised text-fg shadow-sm'
                    : 'text-fg-muted hover:bg-surface-raised/60 hover:text-fg'
                }`}
              >
                {value[0]?.toUpperCase()}
                {value.slice(1)}
              </button>
            ))}
          </fieldset>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-5">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-edge px-5 py-12 text-center">
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
                  <ul className="overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-sm">
                    {groupedRows.map(({ session }) => (
                      <li key={session.id} className="border-b border-edge last:border-b-0">
                        <div className="flex items-start gap-4 px-4 py-3.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <GlanceChip session={session} />
                              <h3 className="min-w-0 truncate text-sm font-semibold text-fg">{session.title}</h3>
                              <span className="truncate text-xs text-fg-muted">#{session.channelId}</span>
                            </div>
                            <p className="mt-2 line-clamp-2 text-sm leading-5 text-fg-body">
                              {waitingDetail(session, kind)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => onFocusAgent(session.id)}
                            className="mt-0.5 shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold text-accent-text hover:bg-accent-hover/10"
                          >
                            {ACTION_LABELS[kind]}
                          </button>
                        </div>
                      </li>
                    ))}
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
