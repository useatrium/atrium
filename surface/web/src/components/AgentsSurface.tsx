import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCost, formatTime, isTerminalSessionStatus, type SessionListItem } from '@atrium/surface-client';
import { sessionsApi } from '../sessions/api';
import type { Session } from '../sessions/types';
import { StatusChip } from '../sessions/SessionCard';

const RECENT_CAP = 200;

type SessionListItemAttentionFields = {
  needsAttention?: unknown;
};

type Group = {
  key: string;
  label: string;
  sessions: SessionListItem[];
};

function sessionNeedsAttention(session: SessionListItem, liveSession?: Session): boolean {
  if ((session as SessionListItem & SessionListItemAttentionFields).needsAttention === true) return true;
  return liveSession?.pendingQuestion != null || liveSession?.providerAuthRequired != null;
}

function sessionFreshness(session: SessionListItem): number {
  const timestamp = session.completedAt ?? session.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionMatchesSearch(session: SessionListItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [session.title, session.channelName, session.spawnerName, session.harness]
    .some((value) => value.toLowerCase().includes(normalized));
}

function groupSessions(
  sessions: SessionListItem[],
  liveSessions: Record<string, Session>,
): Group[] {
  const needsYou: SessionListItem[] = [];
  const active: SessionListItem[] = [];
  const recent: SessionListItem[] = [];
  for (const session of sessions) {
    if (sessionNeedsAttention(session, liveSessions[session.id])) needsYou.push(session);
    else if (isTerminalSessionStatus(session.status)) recent.push(session);
    else active.push(session);
  }
  const byNewest = (a: SessionListItem, b: SessionListItem) => sessionFreshness(b) - sessionFreshness(a);
  needsYou.sort(byNewest);
  active.sort(byNewest);
  recent.sort(byNewest);
  return [
    { key: 'needs', label: 'Needs you', sessions: needsYou },
    { key: 'active', label: 'Active', sessions: active },
    { key: 'recent', label: 'Recent', sessions: recent.slice(0, RECENT_CAP) },
  ].filter((group) => group.sessions.length > 0);
}

export function AgentsSurface({
  liveSessions,
  refreshKey,
  onOpenSession,
}: {
  liveSessions: Record<string, Session>;
  refreshKey: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionsApi.list({ status: 'all', limit: 200 });
      setSessions(response.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load agent sessions');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      void sessionsApi
        .list({ status: 'all', limit: 200 })
        .then(({ sessions }) => setSessions(sessions))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [refreshKey]);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesSearch(session, query)),
    [query, sessions],
  );
  const groups = useMemo(() => groupSessions(visibleSessions, liveSessions), [liveSessions, visibleSessions]);
  const total = visibleSessions.length;

  return (
    <div data-testid="agents-surface" className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold text-fg">Agents</h2>
      </div>

      <div className="border-b border-edge px-4 py-3">
        <label className="sr-only" htmlFor="agents-session-search">
          Search agent sessions
        </label>
        <input
          id="agents-session-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          className="h-9 w-full max-w-xl rounded-md border border-edge-strong bg-surface-raised px-3 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
        />
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading agent sessions...</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <button
              type="button"
              onClick={() => void load()}
              className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-sm text-danger hover:bg-danger/15"
            >
              Agent sessions failed. Click to retry.
            </button>
          )}

          {total === 0 && !error ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-1.5 text-center">
              <div className="text-sm font-medium text-fg-secondary">
                {query.trim() ? 'No matching sessions' : 'No agent sessions yet'}
              </div>
              <div className="max-w-sm text-xs leading-relaxed text-fg-muted">
                {query.trim()
                  ? 'Try a different title, channel, spawner, or harness.'
                  : 'Start one by typing @agent and a task in a channel.'}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl">
              {groups.map((group) => (
                <section key={group.key} className="mb-5 last:mb-0">
                  <div className="mb-1.5 flex items-center gap-2 px-1 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                    <span>{group.label}</span>
                    <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
                    {group.key === 'needs' && <span className="size-1.5 rounded-full bg-warning" />}
                  </div>
                  <div className="overflow-hidden rounded-md border border-edge bg-surface-raised/50">
                    {group.sessions.map((session) => (
                      <AgentSessionListButton
                        key={session.id}
                        session={session}
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentSessionListButton({
  session,
  onOpenSession,
}: {
  session: SessionListItem;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenSession(session.id)}
      className="flex w-full min-w-0 items-center gap-3 border-b border-edge px-3 py-2 text-left last:border-b-0 hover:bg-accent/20"
    >
      <StatusChip status={session.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{session.title}</span>
        <span className="block truncate text-2xs text-fg-muted">
          #{session.channelName} · {session.spawnerName} · {formatTime(session.createdAt)}
        </span>
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
        {session.costUsd > 0 ? formatCost(session.costUsd) : ''}
      </span>
    </button>
  );
}
