// Channel view's right rail: the channel's agent sessions, status-grouped into
// Needs you / Active / Recent (the survey's "jump to what needs attention"
// pattern). Cards reuse SessionCard; clicking one opens it as a peek (→ Split).

import { useMemo } from 'react';
import { SessionCard } from './SessionCard';
import { isTerminalSessionStatus, type Session } from './types';

const RECENT_CAP = 12;

type Group = { key: string; label: string; sessions: Session[] };

function groupSessions(sessions: Session[]): Group[] {
  const needsYou: Session[] = [];
  const active: Session[] = [];
  const recent: Session[] = [];
  for (const s of sessions) {
    if (s.pendingQuestion || s.providerAuthRequired) needsYou.push(s);
    else if (isTerminalSessionStatus(s.status)) recent.push(s);
    else active.push(s);
  }
  const byNewest = (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt);
  needsYou.sort(byNewest);
  active.sort(byNewest);
  recent.sort(byNewest);
  return [
    { key: 'needs', label: 'Needs you', sessions: needsYou },
    { key: 'active', label: 'Active', sessions: active },
    { key: 'recent', label: 'Recent', sessions: recent.slice(0, RECENT_CAP) },
  ].filter((g) => g.sessions.length > 0);
}

export function SessionsRail({
  channelId,
  sessions,
  onOpenSession,
}: {
  channelId: string | null;
  sessions: Record<string, Session>;
  onOpenSession: (sessionId: string) => void;
}) {
  const groups = useMemo(() => {
    if (!channelId) return [];
    const list = Object.values(sessions).filter((s) => s.channelId === channelId);
    return groupSessions(list);
  }, [channelId, sessions]);

  const total = groups.reduce((n, g) => n + g.sessions.length, 0);

  return (
    <aside className="flex w-[min(340px,30vw)] shrink-0 flex-col border-l border-edge bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4">
        <h2 className="text-sm font-semibold text-fg">Sessions</h2>
        {total > 0 && <span className="text-2xs tabular-nums text-fg-muted">{total}</span>}
      </header>

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <div className="text-sm font-medium text-fg-secondary">No sessions yet</div>
          <div className="text-xs leading-relaxed text-fg-muted">
            Start one by typing <span className="font-medium text-fg-secondary">@agent</span> and a
            task in the channel.
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {groups.map((group) => (
            <section key={group.key} className="mb-3 last:mb-0">
              <div className="px-1 pb-1 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                {group.label}
                {group.key === 'needs' && (
                  <span className="ml-1.5 inline-block size-1.5 rounded-full bg-warning align-middle" />
                )}
              </div>
              <div className="space-y-1.5">
                {group.sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    spectators={0}
                    onOpenPane={onOpenSession}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
