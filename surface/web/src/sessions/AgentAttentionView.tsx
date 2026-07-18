import type { Session } from './types';
import { agentDockGroups } from './useAgentDock';

export type AgentAttentionViewProps = {
  sessions: Record<string, Session>;
  onFocusAgent: (id: string) => void;
};

export function AgentAttentionView({ sessions, onFocusAgent }: AgentAttentionViewProps) {
  const needsYou =
    agentDockGroups(sessions, { now: Date.now() }).find((group) => group.kind === 'needs')?.sessions ?? [];
  return (
    <section data-testid="agent-attention" className="min-h-0 flex-1 overflow-y-auto bg-surface p-4">
      <h1 className="mb-3 text-sm font-bold text-fg">Agents needing you</h1>
      <ul className="space-y-1">
        {needsYou.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => onFocusAgent(session.id)}
              className="w-full rounded border border-edge px-3 py-2 text-left text-sm text-fg hover:bg-surface-overlay"
            >
              {session.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
