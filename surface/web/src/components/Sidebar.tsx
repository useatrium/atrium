import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type Channel } from '../api';
import { formatCost, formatTime, isTerminalSessionStatus, type SessionListItem } from '@atrium/surface-client';
import { notificationState, toggleNotifications, type NotifyState } from '../notify';
import type { UnreadLevel, UserRef } from '@atrium/surface-client';
import { channelLabel, dmPartner } from '@atrium/surface-client';
import { sessionsApi } from '../sessions/api';
import { StatusChip } from '../sessions/SessionCard';
import { Avatar } from './Avatar';

const BELL_TITLES: Record<NotifyState, string> = {
  on: 'Notifications on (mentions + your sessions) — click to turn off',
  off: 'Notifications off — click to enable',
  denied: 'Notifications blocked in browser settings',
  unsupported: 'Notifications not supported here',
};

export function Sidebar({
  workspaceName,
  channels,
  activeChannelId,
  unread,
  me,
  wsStatus,
  onSelect,
  onSetMute,
  onCreateChannel,
  onStartDm,
  onOpenSession,
  sessionEventSeq,
  onLogout,
}: {
  workspaceName: string;
  channels: Channel[];
  activeChannelId: string | null;
  unread: Record<string, UnreadLevel>;
  me: UserRef;
  wsStatus: 'connecting' | 'open' | 'closed';
  onSelect: (channelId: string) => void;
  onSetMute: (channelId: string, muted: boolean) => void;
  onCreateChannel: (name: string, isPrivate?: boolean) => Promise<void>;
  onStartDm: (userIds: string[]) => void;
  onOpenSession: (sessionId: string) => void;
  sessionEventSeq: number;
  onLogout: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [privateChannel, setPrivateChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyState>(() => notificationState());
  const [dmPicking, setDmPicking] = useState(false);
  const [dmQuery, setDmQuery] = useState('');
  const [people, setPeople] = useState<UserRef[] | null>(null);
  const [selectedDmIds, setSelectedDmIds] = useState<Set<string>>(new Set());

  const publicChannels = channels.filter((c) => c.kind !== 'dm' && c.kind !== 'gdm');
  const dms = channels.filter((c) => c.kind === 'dm' || c.kind === 'gdm');

  const openDmPicker = () => {
    setDmPicking((v) => !v);
    setDmQuery('');
    setSelectedDmIds(new Set());
    if (people === null) {
      api
        .users()
        .then(({ users }) => setPeople(users))
        .catch(() => setPeople([]));
    }
  };
  const dmCandidates = (people ?? []).filter(
    (u) =>
      u.handle.toLowerCase().includes(dmQuery.trim().toLowerCase()) ||
      u.displayName.toLowerCase().includes(dmQuery.trim().toLowerCase()),
  );

  const unreadBadge = (channelId: string, active: boolean) => {
    if (channels.find((c) => c.id === channelId)?.muted) return null;
    const level = active ? false : unread[channelId] ?? false;
    if (level === 'mention') {
      return (
        <span className="ml-auto shrink-0 rounded bg-red-500/90 px-1 text-[10px] font-bold leading-4 text-white">
          @<span className="sr-only"> mention</span>
        </span>
      );
    }
    if (level) {
      return (
        <span className="ml-auto size-2 shrink-0 rounded-full bg-indigo-400">
          <span className="sr-only">unread</span>
        </span>
      );
    }
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      await onCreateChannel(n, privateChannel);
      setName('');
      setPrivateChannel(false);
      setCreating(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 px-4">
        <span className="truncate text-sm font-bold tracking-tight text-zinc-100">
          {workspaceName}
        </span>
        <span
          role="status"
          title={`connection: ${wsStatus}`}
          className={`ml-auto size-2 shrink-0 rounded-full ${
            wsStatus === 'open'
              ? 'bg-emerald-500'
              : wsStatus === 'connecting'
                ? 'animate-pulse bg-amber-500'
                : 'bg-red-500'
          }`}
        >
          <span className="sr-only">connection: {wsStatus}</span>
        </span>
      </header>

      <div className="flex-1 overflow-y-auto py-3">
        <div className="flex items-center justify-between px-4 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Channels
          </span>
          <button
            onClick={() => {
              setCreating((v) => !v);
              setError(null);
            }}
            title="Create channel"
            aria-label="Create channel"
            className="rounded px-1.5 text-sm leading-5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            +
          </button>
        </div>

        {creating && (
          <form onSubmit={submit} className="px-3 pb-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation(); // don't also close an open side panel
                setCreating(false);
              }}
              placeholder="new-channel-name"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
            />
            <label className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={privateChannel}
                onChange={(e) => setPrivateChannel(e.target.checked)}
                className="accent-indigo-500"
              />
              Private
            </label>
            {error && <div className="pt-1 text-[11px] text-red-400">{error}</div>}
          </form>
        )}

        <ul>
          {publicChannels.map((c) => {
            const active = c.id === activeChannelId;
            const level = c.muted || active ? false : unread[c.id] ?? false;
            return (
              <li key={c.id} className="group flex items-center">
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-4 text-left text-sm ${
                    active
                      ? 'bg-indigo-600/20 font-medium text-zinc-100'
                      : level
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/70'
                        : c.muted
                          ? 'text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-500'
                          : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-zinc-500">{c.kind === 'private' ? '🔒' : '#'}</span>
                  <span className="truncate">{c.name}</span>
                  {unreadBadge(c.id, active)}
                </button>
                <button
                  onClick={() => onSetMute(c.id, !c.muted)}
                  title={c.muted ? 'Unmute channel' : 'Mute channel'}
                  aria-label={c.muted ? `Unmute ${c.name}` : `Mute ${c.name}`}
                  className={`shrink-0 px-3 py-1 text-xs hover:bg-zinc-800 hover:text-zinc-200 ${
                    c.muted ? 'text-zinc-500' : 'text-zinc-600 opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {c.muted ? '🔕' : '🔔'}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center justify-between px-4 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Direct messages
          </span>
          <button
            onClick={openDmPicker}
            title="Start a DM"
            aria-label="Start a DM"
            className="rounded px-1.5 text-sm leading-5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            +
          </button>
        </div>

        {dmPicking && (
          <div className="px-3 pb-2">
            <input
              autoFocus
              value={dmQuery}
              onChange={(e) => setDmQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                setDmPicking(false);
              }}
              placeholder="who?"
              aria-label="Find a person to message"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
            />
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {people === null && <li className="px-2 py-1 text-[11px] text-zinc-500">loading…</li>}
              {dmCandidates.map((u) => (
                <li key={u.id}>
                  <button
                    onClick={() => {
                      setSelectedDmIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.id)) next.delete(u.id);
                        else next.add(u.id);
                        return next;
                      });
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    <Avatar name={u.displayName} seed={u.id} size={16} />
                    <span className="truncate">{u.displayName}</span>
                    <span className="truncate text-zinc-600">@{u.handle}</span>
                    {u.id === me.id && <span className="text-zinc-600">(you)</span>}
                    {selectedDmIds.has(u.id) && <span className="ml-auto text-indigo-300">✓</span>}
                  </button>
                </li>
              ))}
            </ul>
            {selectedDmIds.size > 0 && (
              <button
                onClick={() => {
                  setDmPicking(false);
                  onStartDm([...selectedDmIds]);
                }}
                className="mt-2 w-full rounded-md bg-indigo-500 px-2 py-1 text-xs font-semibold text-white"
              >
                Start {selectedDmIds.size > 1 ? 'group DM' : 'DM'}
              </button>
            )}
          </div>
        )}

        <ul>
        {dms.map((c) => {
            const active = c.id === activeChannelId;
            const level = c.muted || active ? false : unread[c.id] ?? false;
            const label = channelLabel(c, me.id);
            const partner = dmPartner(c, me.id);
            return (
              <li key={c.id} className="group flex items-center">
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 py-1 pl-4 text-left text-sm ${
                    active
                      ? 'bg-indigo-600/20 font-medium text-zinc-100'
                      : level
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/70'
                        : c.muted
                          ? 'text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-500'
                          : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <Avatar name={label} seed={partner?.id ?? c.id} size={16} />
                  <span className="truncate">{label}</span>
                  {unreadBadge(c.id, active)}
                </button>
                <button
                  onClick={() => onSetMute(c.id, !c.muted)}
                  title={c.muted ? 'Unmute DM' : 'Mute DM'}
                  aria-label={c.muted ? `Unmute ${label}` : `Mute ${label}`}
                  className={`shrink-0 px-3 py-1 text-xs hover:bg-zinc-800 hover:text-zinc-200 ${
                    c.muted ? 'text-zinc-500' : 'text-zinc-600 opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {c.muted ? '🔕' : '🔔'}
                </button>
              </li>
            );
          })}
        </ul>

        <SessionSidebarSection
          refreshKey={sessionEventSeq}
          onOpenSession={onOpenSession}
        />
      </div>

      <footer className="flex items-center gap-1 border-t border-zinc-800 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-200">{me.displayName}</div>
          <div className="truncate text-[11px] text-zinc-500">@{me.handle}</div>
        </div>
        <button
          onClick={() => {
            void toggleNotifications().then(setNotify);
          }}
          disabled={notify === 'denied' || notify === 'unsupported'}
          title={BELL_TITLES[notify]}
          aria-label={BELL_TITLES[notify]}
          className="rounded-md px-1.5 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          {notify === 'on' ? '🔔' : '🔕'}
        </button>
        <button
          onClick={onLogout}
          className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          Log out
        </button>
      </footer>
    </nav>
  );
}

function SessionSidebarSection({
  refreshKey,
  onOpenSession,
}: {
  refreshKey: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = () => {
      sessionsApi
        .list({ status: 'all', limit: 50 })
        .then(({ sessions }) => {
          if (!disposed) setSessions(sessions);
        })
        .catch(() => {
          if (!disposed) setSessions([]);
        });
    };
    load();
    const poll = setInterval(load, 30_000);
    return () => {
      disposed = true;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      sessionsApi
        .list({ status: 'all', limit: 50 })
        .then(({ sessions }) => setSessions(sessions))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [refreshKey]);

  const running = useMemo(
    () => sessions.filter((s) => !isTerminalSessionStatus(s.status)),
    [sessions],
  );
  const preview = running.slice(0, 5);
  const open = (id: string) => {
    onOpenSession(id);
    setModalOpen(false);
  };

  return (
    <>
      <div className="mt-4 flex items-center justify-between px-4 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Sessions
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-400">
          {running.length}
        </span>
      </div>
      <ul>
        {preview.map((session) => (
          <li key={session.id}>
            <button
              onClick={() => open(session.id)}
              className="flex w-full min-w-0 flex-col gap-1 px-4 py-1.5 text-left hover:bg-zinc-800/70"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusChip status={session.status} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                  {session.title}
                </span>
              </span>
              <span className="truncate pl-1 text-[11px] text-zinc-600">
                #{session.channelName}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            onClick={() => setModalOpen(true)}
            className="w-full px-4 py-1 text-left text-xs font-medium text-indigo-400 hover:bg-zinc-800/70"
          >
            View all
          </button>
        </li>
      </ul>
      {modalOpen && (
        <SessionBrowserModal
          sessions={sessions}
          onOpenSession={open}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function SessionBrowserModal({
  sessions,
  onOpenSession,
  onClose,
}: {
  sessions: SessionListItem[];
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-zinc-950/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Browse sessions"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-24 w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-3 py-2.5 text-sm font-semibold text-zinc-100">
          Sessions
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onOpenSession(session.id)}
              className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-indigo-600/20"
            >
              <StatusChip status={session.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100">
                  {session.title}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  #{session.channelName} · {session.spawnerName} · {formatTime(session.createdAt)}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                {session.costUsd > 0 ? formatCost(session.costUsd) : ''}
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-zinc-500">No sessions yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
