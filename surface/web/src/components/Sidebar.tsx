import { useState, type FormEvent } from 'react';
import type { Channel } from '../api';
import type { UserRef } from '../state';

export function Sidebar({
  workspaceName,
  channels,
  activeChannelId,
  unread,
  me,
  wsStatus,
  onSelect,
  onCreateChannel,
  onLogout,
}: {
  workspaceName: string;
  channels: Channel[];
  activeChannelId: string | null;
  unread: Record<string, boolean>;
  me: UserRef;
  wsStatus: 'connecting' | 'open' | 'closed';
  onSelect: (channelId: string) => void;
  onCreateChannel: (name: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

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
          {channels.map((c) => {
            const active = c.id === activeChannelId;
            const isUnread = unread[c.id] && !active;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex w-full items-center gap-1.5 px-4 py-1 text-left text-sm ${
                    active
                      ? 'bg-indigo-600/20 font-medium text-zinc-100'
                      : isUnread
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/70'
                        : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-zinc-500">#</span>
                  <span className="truncate">{c.name}</span>
                  {isUnread && (
                    <span className="ml-auto size-2 shrink-0 rounded-full bg-indigo-400">
                      <span className="sr-only">unread</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-200">{me.displayName}</div>
          <div className="truncate text-[11px] text-zinc-500">@{me.handle}</div>
        </div>
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
