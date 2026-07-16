import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  formatCost,
  formatOutcome,
  formatTime,
  isUnknownSessionStatus,
  isTerminalSessionStatus,
  sessionAttentionKind,
  type SessionListItem,
} from '@atrium/surface-client';
import { navigate } from '../router';
import { sessionsApi } from '../sessions/api';
import type { Session, SessionGlanceInput } from '../sessions/types';
import { GlanceChip } from '../sessions/GlanceChip';
import { MessageActionMenu, type MessageActionMenuState } from './MessageActionMenu';

const RECENT_CAP = 200;

type Group = {
  key: string;
  label: string;
  sessions: SessionListItem[];
};

type SessionRowMenu = {
  session: SessionListItem;
  state: MessageActionMenuState;
};

function sessionNeedsAttention(session: SessionListItem, liveSession?: Session): boolean {
  if (session.needsAttention) return true;
  return liveSession != null && sessionAttentionKind(liveSession) != null;
}

/** Chip input: the live entity when the socket has one, else the REST row. */
function glanceInputFor(session: SessionListItem, live?: Session): SessionGlanceInput {
  const rest = {
    status: session.status,
    pendingSeatRequests: [],
    createdAt: session.createdAt,
    completedAt: session.completedAt,
  };
  if (!live) return rest;
  if (!isUnknownSessionStatus(live.status)) return live;
  // A fold-only entity can still carry useful question/auth/seat state, but its
  // unknown lifecycle must not replace the REST row's durable status and clock.
  return {
    ...live,
    status: rest.status,
    createdAt: rest.createdAt,
    completedAt: rest.completedAt,
  };
}

function sessionFreshness(session: SessionListItem): number {
  const timestamp = session.completedAt ?? session.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalElapsedMs(session: SessionListItem): number {
  const start = Date.parse(session.createdAt);
  const end = Date.parse(session.completedAt ?? session.createdAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function sessionMatchesSearch(session: SessionListItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [session.title, session.channelName, session.spawnerName, session.harness].some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

function groupSessions(sessions: SessionListItem[], liveSessions: Record<string, Session>): Group[] {
  const pinned: SessionListItem[] = [];
  const needsYou: SessionListItem[] = [];
  const active: SessionListItem[] = [];
  const recent: SessionListItem[] = [];
  for (const session of sessions) {
    // The list endpoint already excludes archived rows, but a session archived
    // live sits in this cache until the refetch lands — keep it out of view.
    if (session.archivedAt) continue;
    if (session.pinned) pinned.push(session);
    else if (sessionNeedsAttention(session, liveSessions[session.id])) needsYou.push(session);
    else if (isTerminalSessionStatus(session.status)) recent.push(session);
    else active.push(session);
  }
  const byNewest = (a: SessionListItem, b: SessionListItem) => sessionFreshness(b) - sessionFreshness(a);
  pinned.sort(byNewest);
  needsYou.sort(byNewest);
  active.sort(byNewest);
  recent.sort(byNewest);
  return [
    { key: 'pinned', label: 'Pinned', sessions: pinned },
    { key: 'needs', label: 'Needs you', sessions: needsYou },
    { key: 'active', label: 'Active', sessions: active },
    { key: 'recent', label: 'Recent', sessions: recent.slice(0, RECENT_CAP) },
  ].filter((group) => group.sessions.length > 0);
}

export function AgentsSurface({
  liveSessions,
  refreshKey,
  onOpenSession,
  onSetSessionPinned,
  onSetSessionArchived,
}: {
  liveSessions: Record<string, Session>;
  refreshKey: number;
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned?: (sessionId: string, pinned: boolean, previousPinned: boolean) => void;
  onSetSessionArchived?: (sessionId: string, archived: boolean, previousArchivedAt: string | null) => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<SessionListItem[] | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [rowMenu, setRowMenu] = useState<SessionRowMenu | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionsApi.list({ status: 'all', limit: 200 });
      setSessions(response.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load agents');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const response = await sessionsApi.list({ status: 'archived', limit: 200 });
      setArchived(response.sessions);
    } catch {
      setArchived((prev) => prev ?? []);
    } finally {
      setArchivedLoading(false);
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
      if (archivedOpen) void loadArchived();
    }, 180);
    return () => clearTimeout(t);
  }, [archivedOpen, loadArchived, refreshKey]);

  useEffect(() => {
    if (archivedOpen && archived == null) void loadArchived();
  }, [archived, archivedOpen, loadArchived]);

  const togglePin = useCallback(
    (session: SessionListItem) => {
      const pinned = !session.pinned;
      onSetSessionPinned?.(session.id, pinned, session.pinned);
      setSessions((rows) => rows.map((row) => (row.id === session.id ? { ...row, pinned } : row)));
      setArchived((rows) => rows?.map((row) => (row.id === session.id ? { ...row, pinned } : row)) ?? rows);
    },
    [onSetSessionPinned],
  );

  const toggleArchive = useCallback(
    (session: SessionListItem) => {
      const archive = session.archivedAt == null;
      onSetSessionArchived?.(session.id, archive, session.archivedAt);
      // Reflect immediately in the local caches; the durable event + refetch heal.
      const archivedAt = archive ? new Date().toISOString() : null;
      if (archive) {
        setSessions((rows) => rows.filter((row) => row.id !== session.id));
        setArchived((rows) => (rows == null ? rows : [{ ...session, archivedAt }, ...rows]));
      } else {
        setArchived((rows) => rows?.filter((row) => row.id !== session.id) ?? rows);
        setSessions((rows) => [{ ...session, archivedAt }, ...rows.filter((row) => row.id !== session.id)]);
      }
    },
    [onSetSessionArchived],
  );

  const openRowMenu = useCallback((session: SessionListItem, event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setRowMenu({ session, state: { mode: 'popover', anchor: { x: rect.right - 240, y: rect.bottom + 4 } } });
  }, []);

  const rowActions = useMemo(() => {
    if (!rowMenu) return [];
    const { session } = rowMenu;
    const isArchived = session.archivedAt != null;
    return [
      ...(isArchived
        ? []
        : [
            {
              key: 'pin',
              label: session.pinned ? 'Unpin' : 'Pin',
              onSelect: () => togglePin(session),
            },
          ]),
      {
        key: 'archive',
        label: isArchived ? 'Unarchive' : 'Archive',
        onSelect: () => toggleArchive(session),
      },
    ];
  }, [rowMenu, toggleArchive, togglePin]);

  const canActOnRows = onSetSessionPinned != null || onSetSessionArchived != null;

  const visibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesSearch(session, query)),
    [query, sessions],
  );
  const groups = useMemo(() => groupSessions(visibleSessions, liveSessions), [liveSessions, visibleSessions]);
  const total = visibleSessions.filter((session) => session.archivedAt == null).length;
  const visibleArchived = useMemo(
    () => (archived ?? []).filter((session) => sessionMatchesSearch(session, query)),
    [archived, query],
  );

  return (
    <div data-testid="agents-surface" className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold text-fg">Agents</h2>
      </div>

      <div className="border-b border-edge px-4 py-3">
        <label className="sr-only" htmlFor="agents-session-search">
          Search agents
        </label>
        <input
          id="agents-session-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search agents"
          className="h-9 w-full max-w-xl rounded-md border border-edge-strong bg-surface-raised px-3 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover max-md:h-11 max-md:text-base"
        />
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading agents…</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <button
              type="button"
              onClick={() => void load()}
              className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-sm text-danger hover:bg-danger/15 max-md:min-h-11"
            >
              Agents failed to load. Click to retry.
            </button>
          )}

          {total === 0 && !error ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-1.5 text-center">
              <div className="text-sm font-medium text-fg-secondary">
                {query.trim() ? 'No matching agents' : 'No agents yet'}
              </div>
              <div className="max-w-sm text-xs leading-relaxed text-fg-muted">
                {query.trim()
                  ? 'Try a different title, channel, spawner, or harness.'
                  : 'Start one by typing !! and a task in a channel.'}
              </div>
              {!query.trim() && (
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="mt-2 inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover max-md:h-11"
                >
                  Start an agent
                </button>
              )}
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
                        live={liveSessions[session.id]}
                        onOpenSession={onOpenSession}
                        onOpenMenu={canActOnRows ? openRowMenu : undefined}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          <section className="mt-6 max-w-3xl border-t border-edge pt-3">
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              aria-expanded={archivedOpen}
              className="flex w-full items-center gap-2 px-1 py-1 text-3xs font-semibold uppercase tracking-wider text-fg-muted hover:text-fg-secondary max-md:min-h-11"
            >
              <span aria-hidden className="inline-block w-3 text-center">
                {archivedOpen ? '▾' : '▸'}
              </span>
              <span>Archived</span>
              {archived != null && <span className="tabular-nums text-fg-faint">{visibleArchived.length}</span>}
            </button>
            {archivedOpen &&
              (archivedLoading && archived == null ? (
                <div className="px-1 py-2 text-xs text-fg-muted">Loading archived agents…</div>
              ) : visibleArchived.length === 0 ? (
                <div className="px-1 py-2 text-xs text-fg-muted">No archived agents.</div>
              ) : (
                <div className="mt-1.5 overflow-hidden rounded-md border border-edge bg-surface-raised/30">
                  {visibleArchived.map((session) => (
                    <AgentSessionListButton
                      key={session.id}
                      session={session}
                      live={liveSessions[session.id]}
                      onOpenSession={onOpenSession}
                      onOpenMenu={canActOnRows ? openRowMenu : undefined}
                    />
                  ))}
                </div>
              ))}
          </section>
        </div>
      )}

      <MessageActionMenu
        state={rowMenu?.state ?? null}
        onClose={() => setRowMenu(null)}
        actions={rowActions}
        label="Agent actions"
      />
    </div>
  );
}

function AgentSessionListButton({
  session,
  live,
  onOpenSession,
  onOpenMenu,
}: {
  session: SessionListItem;
  /** Live entity from the workspace socket, when present — richer status. */
  live?: Session;
  onOpenSession: (sessionId: string) => void;
  onOpenMenu?: (session: SessionListItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  // The REST row can flag needs-attention without carrying the live fields
  // that prove it — honor the flag so the chip never contradicts the group.
  const flaggedOnly = (!live || isUnknownSessionStatus(live.status)) && session.needsAttention;
  return (
    <div className="group/agent-row flex w-full min-w-0 items-center border-b border-edge last:border-b-0 hover:bg-accent/20">
      <button
        type="button"
        onClick={() => onOpenSession(session.id)}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left max-md:min-h-11"
      >
        <GlanceChip
          session={glanceInputFor(session, live)}
          override={flaggedOnly ? { kind: 'needs_you', label: 'Needs you' } : undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {session.pinned && (
              <span aria-label="Pinned" role="img" title="Pinned" className="shrink-0 text-2xs text-fg-muted">
                📌
              </span>
            )}
            <span className="truncate text-sm font-medium text-fg">{session.title}</span>
          </span>
          <span className="block truncate text-2xs text-fg-muted">
            #{session.channelName} · {session.spawnerName} ·{' '}
            {isTerminalSessionStatus(session.status)
              ? formatOutcome(session.status, terminalElapsedMs(session))
              : formatTime(session.createdAt)}
          </span>
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
          {session.costUsd > 0 ? formatCost(session.costUsd) : ''}
        </span>
      </button>
      {onOpenMenu && (
        <button
          type="button"
          aria-label={`Agent actions for ${session.title}`}
          aria-haspopup="dialog"
          onClick={(event) => onOpenMenu(session, event)}
          className="mr-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 hover:bg-edge-strong hover:text-fg focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover/agent-row:opacity-100 max-md:size-9 max-md:opacity-100"
        >
          ⋯
        </button>
      )}
    </div>
  );
}
