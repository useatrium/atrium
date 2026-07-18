import type { Channel } from '@atrium/surface-client';
import type { Session } from './types';
import { agentDockCounts, agentDockGroups } from './useAgentDock';

export type AgentDockProps = {
  sessions: Record<string, Session>;
  channels: Channel[];
  activeChannelId: string | null;
  focusedSessionId: string | null;
  immersed: boolean;
  onFocusAgent: (id: string) => void;
  onToggleImmersed: () => void;
  onNewAgent: () => void;
  filterChannelId?: string | null;
  /** Foundation seam for the full Needs-you view; the dock lane will place it. */
  onOpenAttention?: () => void;
};

export function AgentDock({
  sessions,
  channels,
  activeChannelId,
  focusedSessionId,
  immersed,
  onFocusAgent,
  onToggleImmersed,
  onNewAgent,
  filterChannelId,
  onOpenAttention,
}: AgentDockProps) {
  const filteredSessions = filterChannelId
    ? Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.channelId === filterChannelId))
    : sessions;
  const counts = agentDockCounts(filteredSessions);
  const groups = agentDockGroups(filteredSessions, { activeChannelId, now: Date.now(), channels });

  return (
    <aside
      data-testid="agent-dock"
      aria-label="Agents"
      className={`shrink-0 border-l border-edge bg-surface-raised ${immersed ? 'w-64 overflow-y-auto p-2' : 'w-13'}`}
    >
      {!immersed ? (
        <div className="flex h-full flex-col items-center gap-2 py-2 text-xs text-fg-muted">
          <button type="button" onClick={onToggleImmersed} aria-label="Open agent dock" className="font-bold">
            A
          </button>
          <span title="Needs you" className="tabular-nums text-warning-text">
            {counts.needsYou}
          </span>
          <span title="Live" className="tabular-nums">
            {counts.live}
          </span>
          <button type="button" onClick={onNewAgent} aria-label="New agent" className="mt-auto text-base">
            +
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
            <button type="button" onClick={onToggleImmersed} className="font-semibold text-fg">
              Agents
            </button>
            <span className="tabular-nums">{counts.needsYou} need you</span>
          </div>
          {onOpenAttention && (
            <button type="button" onClick={onOpenAttention} className="text-xs font-semibold text-accent-text">
              Triage needs-you →
            </button>
          )}
          {groups.map((group) => (
            <section key={group.key}>
              <h2 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-fg-muted">{group.label}</h2>
              <ul className="space-y-1">
                {group.sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      aria-current={session.id === focusedSessionId ? 'true' : undefined}
                      onClick={() => onFocusAgent(session.id)}
                      className="w-full truncate rounded px-2 py-1 text-left text-xs text-fg hover:bg-surface-overlay"
                    >
                      {session.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <button type="button" onClick={onNewAgent} className="text-xs font-semibold text-accent-text">
            New agent
          </button>
        </div>
      )}
    </aside>
  );
}
