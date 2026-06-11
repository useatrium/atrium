import { useState, type FormEvent } from 'react';
import { api, type Channel } from '../api';
import type { UnreadLevel } from '../appState';
import { notificationState, toggleNotifications, type NotifyState } from '../notify';
import type { UserRef } from '../state';
import { channelLabel, dmPartner } from '../util';
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
  onCreateChannel,
  onStartDm,
  onLogout,
}: {
  workspaceName: string;
  channels: Channel[];
  activeChannelId: string | null;
  unread: Record<string, UnreadLevel>;
  me: UserRef;
  wsStatus: 'connecting' | 'open' | 'closed';
  onSelect: (channelId: string) => void;
  onCreateChannel: (name: string) => Promise<void>;
  onStartDm: (userId: string) => void;
  onLogout: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyState>(() => notificationState());
  const [dmPicking, setDmPicking] = useState(false);
  const [dmQuery, setDmQuery] = useState('');
  const [people, setPeople] = useState<UserRef[] | null>(null);

  const publicChannels = channels.filter((c) => c.kind !== 'dm');
  const dms = channels.filter((c) => c.kind === 'dm');

  const openDmPicker = () => {
    setDmPicking((v) => !v);
    setDmQuery('');
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
      await onCreateChannel(n);
      setName('');
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
            {error && <div className="pt-1 text-[11px] text-red-400">{error}</div>}
          </form>
        )}

        <ul>
          {publicChannels.map((c) => {
            const active = c.id === activeChannelId;
            const level = active ? false : unread[c.id] ?? false;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex w-full items-center gap-1.5 px-4 py-1 text-left text-sm ${
                    active
                      ? 'bg-indigo-600/20 font-medium text-zinc-100'
                      : level
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/70'
                        : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-zinc-500">#</span>
                  <span className="truncate">{c.name}</span>
                  {unreadBadge(c.id, active)}
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
                      setDmPicking(false);
                      onStartDm(u.id);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    <Avatar name={u.displayName} seed={u.id} size={16} />
                    <span className="truncate">{u.displayName}</span>
                    <span className="truncate text-zinc-600">@{u.handle}</span>
                    {u.id === me.id && <span className="text-zinc-600">(you)</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul>
          {dms.map((c) => {
            const active = c.id === activeChannelId;
            const level = active ? false : unread[c.id] ?? false;
            const label = channelLabel(c, me.id);
            const partner = dmPartner(c, me.id);
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex w-full items-center gap-2 px-4 py-1 text-left text-sm ${
                    active
                      ? 'bg-indigo-600/20 font-medium text-zinc-100'
                      : level
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/70'
                        : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <Avatar name={label} seed={partner?.id ?? c.id} size={16} />
                  <span className="truncate">{label}</span>
                  {unreadBadge(c.id, active)}
                </button>
              </li>
            );
          })}
        </ul>
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
