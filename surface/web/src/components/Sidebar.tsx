import {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { api, type Channel } from '../api';
import {
  isTerminalSessionStatus,
  type SessionListItem,
} from '@atrium/surface-client';
import type { UnreadLevel, UserRef } from '@atrium/surface-client';
import { channelAvatarName, channelLabel, dmPartner } from '@atrium/surface-client';
import { sessionsApi } from '../sessions/api';
import { StatusChip } from '../sessions/SessionCard';
import { Avatar } from './Avatar';
import { Tooltip } from './a11y';
import { BellIcon, BellOffIcon, FileIcon, GearIcon, LockIcon } from './icons';
const SIDEBAR_GROUP_TITLE_CLASS = 'px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-fg-muted';
const SIDEBAR_PANEL_CLASS = 'rounded-md border border-edge bg-surface-raised py-1';
const SIDEBAR_SUBHEAD_CLASS = 'flex items-center justify-between px-3 pb-1 pt-1 text-2xs font-semibold text-fg-muted';
const SIDEBAR_ITEM_BASE_CLASS = 'group mx-1 flex min-h-7 items-center rounded-md';
const SIDEBAR_ROW_BUTTON_CLASS = 'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm';

function sidebarItemClass(active: boolean, level: UnreadLevel | false, muted = false): string {
  return `${SIDEBAR_ITEM_BASE_CLASS} ${
    active
      ? 'bg-accent/20 font-medium text-fg'
      : level
        ? 'font-semibold text-fg hover:bg-surface-overlay/70'
        : muted
          ? 'text-fg-faint hover:bg-surface-overlay/70 hover:text-fg-muted'
          : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
  }`;
}

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
  activeSurface = 'chat',
  onOpenFiles,
  onOpenAgents,
  // === mentions-activity additions ===
  onOpenActivity,
  onOpenSettings,
  sessionEventSeq,
  onLogout,
  isOpen = false,
  onClose,
  createChannelRequestSeq,
  startDmRequestSeq,
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
  activeSurface?: 'chat' | 'files' | 'activity' | 'agents' | 'settings';
  onOpenFiles?: () => void;
  onOpenAgents?: () => void;
  // === mentions-activity additions ===
  onOpenActivity?: () => void;
  onOpenSettings?: () => void;
  sessionEventSeq: number;
  onLogout: () => void;
  isOpen?: boolean;
  onClose?: () => void;
  createChannelRequestSeq?: number;
  startDmRequestSeq?: number;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [privateChannel, setPrivateChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dmPicking, setDmPicking] = useState(false);
  const [dmQuery, setDmQuery] = useState('');
  const [people, setPeople] = useState<UserRef[] | null>(null);
  const [selectedDmIds, setSelectedDmIds] = useState<Set<string>>(new Set());
  const lastCreateChannelRequestSeq = useRef(createChannelRequestSeq);
  const lastStartDmRequestSeq = useRef(startDmRequestSeq);
  const createChannelInputRef = useRef<HTMLInputElement | null>(null);
  const dmPickerInputRef = useRef<HTMLInputElement | null>(null);
  const createChannelErrorId = 'sidebar-create-channel-error';

  const publicChannels = channels.filter((c) => c.kind !== 'dm' && c.kind !== 'gdm');
  const dms = channels.filter((c) => c.kind === 'dm' || c.kind === 'gdm');

  const loadPeople = useCallback(() => {
    if (people !== null) return;
    api
      .users()
      .then(({ users }) => setPeople(users))
      .catch(() => setPeople([]));
  }, [people]);

  const openDmPicker = useCallback((forceOpen = false) => {
    setDmPicking((v) => (forceOpen ? true : !v));
    setDmQuery('');
    setSelectedDmIds(new Set());
    loadPeople();
  }, [loadPeople]);
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
        <span className="ml-auto shrink-0 rounded bg-danger-strong px-1 text-3xs font-bold leading-4 text-on-accent">
          @<span className="sr-only"> mention</span>
        </span>
      );
    }
    if (level) {
      return (
        <span className="ml-auto size-2 shrink-0 rounded-full bg-accent-text">
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

  useEffect(() => {
    if (createChannelRequestSeq == null || lastCreateChannelRequestSeq.current === createChannelRequestSeq) return;
    lastCreateChannelRequestSeq.current = createChannelRequestSeq;
    setCreating(true);
    setError(null);
  }, [createChannelRequestSeq]);

  useEffect(() => {
    if (startDmRequestSeq == null || lastStartDmRequestSeq.current === startDmRequestSeq) return;
    lastStartDmRequestSeq.current = startDmRequestSeq;
    openDmPicker(true);
  }, [openDmPicker, startDmRequestSeq]);

  useEffect(() => {
    if (creating) createChannelInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (dmPicking) dmPickerInputRef.current?.focus();
  }, [dmPicking]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/50 motion-safe:transition-opacity md:hidden ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <nav
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-edge bg-surface-raised shadow-2xl motion-safe:transition-transform motion-reduce:transition-none md:static md:z-auto md:w-56 md:max-w-none md:translate-x-0 md:bg-surface-raised md:shadow-none md:transition-none ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4">
        <span className="truncate text-sm font-bold tracking-tight text-fg">
          {workspaceName}
        </span>
        <span
          role="status"
          title={`connection: ${wsStatus}`}
          className={`ml-auto size-2 shrink-0 rounded-full ${
            wsStatus === 'open'
              ? 'bg-success'
              : wsStatus === 'connecting'
                ? 'animate-pulse bg-warning'
                : 'bg-danger'
          }`}
        >
          <span className="sr-only">connection: {wsStatus}</span>
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h2 className={SIDEBAR_GROUP_TITLE_CLASS}>Workspace</h2>
          <div className={SIDEBAR_PANEL_CLASS}>
            <button
              type="button"
              aria-current={activeSurface === 'files' ? 'page' : undefined}
              onClick={onOpenFiles}
              className={`${SIDEBAR_ROW_BUTTON_CLASS} mx-1 w-[calc(100%-0.5rem)] ${
                activeSurface === 'files'
                  ? 'bg-accent/20 font-medium text-fg'
                  : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
              }`}
            >
              <FileIcon size={15} className="shrink-0 text-fg-muted" />
              <span className="truncate">Files</span>
            </button>
            <button
              type="button"
              aria-current={activeSurface === 'agents' ? 'page' : undefined}
              onClick={onOpenAgents}
              className={`${SIDEBAR_ROW_BUTTON_CLASS} mx-1 w-[calc(100%-0.5rem)] ${
                activeSurface === 'agents'
                  ? 'bg-accent/20 font-medium text-fg'
                  : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
              }`}
            >
              <span aria-hidden="true" className="grid w-[15px] shrink-0 place-items-center text-xs font-bold text-fg-muted">
                A
              </span>
              <span className="truncate">Agents</span>
            </button>
            {/* === mentions-activity additions === */}
            <button
              type="button"
              aria-current={activeSurface === 'activity' ? 'page' : undefined}
              onClick={onOpenActivity}
              className={`${SIDEBAR_ROW_BUTTON_CLASS} mx-1 w-[calc(100%-0.5rem)] ${
                activeSurface === 'activity'
                  ? 'bg-accent/20 font-medium text-fg'
                  : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
              }`}
            >
              <span className="grid w-[15px] shrink-0 place-items-center text-xs font-bold text-fg-muted">
                @
              </span>
              <span className="truncate">Activity</span>
            </button>
          </div>
        </section>

        <section className="mt-3">
          <h2 className={SIDEBAR_GROUP_TITLE_CLASS}>Conversations</h2>
          <div className={SIDEBAR_PANEL_CLASS}>
            <div className={SIDEBAR_SUBHEAD_CLASS}>
              <span>Channels</span>
              <Tooltip content="Create channel">
                <button
                  type="button"
                  onClick={() => {
                    setCreating((v) => !v);
                    setError(null);
                  }}
                  aria-label="Create channel"
                  className="rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
                >
                  +
                </button>
              </Tooltip>
            </div>

            {creating && (
              <form onSubmit={submit} className="px-2 pb-2">
                <input
                  ref={createChannelInputRef}
                  value={name}
                  aria-label="Channel name"
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={error ? createChannelErrorId : undefined}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    e.stopPropagation(); // don't also close an open side panel
                    setCreating(false);
                  }}
                  placeholder="new-channel-name"
                  className="w-full rounded-md border border-edge-strong bg-surface-raised px-2 py-1 text-xs text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
                />
                <label className="mt-1 flex items-center gap-2 text-2xs text-fg-tertiary">
                  <input
                    type="checkbox"
                    checked={privateChannel}
                    onChange={(e) => setPrivateChannel(e.target.checked)}
                    className="accent-accent-hover"
                  />
                  Private
                </label>
                {error && <div id={createChannelErrorId} role="alert" className="pt-1 text-2xs text-danger">{error}</div>}
              </form>
            )}

            <ul className="max-h-80 overflow-y-auto pb-1">
              {publicChannels.map((c) => {
                const active = c.id === activeChannelId;
                const level = c.muted || active ? false : unread[c.id] ?? false;
                return (
                  <li key={c.id} className={sidebarItemClass(active, level, c.muted)}>
                    <button type="button" onClick={() => onSelect(c.id)} className={SIDEBAR_ROW_BUTTON_CLASS}>
                      <span className="grid w-4 shrink-0 place-items-center text-fg-muted">
                        {c.kind === 'private' ? <LockIcon size={14} /> : '#'}
                      </span>
                      <span className="truncate">{c.name}</span>
                      {unreadBadge(c.id, active)}
                    </button>
                    <Tooltip content={c.muted ? `Unmute ${c.name}` : `Mute ${c.name}`}>
                      <button
                        type="button"
                        onClick={() => onSetMute(c.id, !c.muted)}
                        aria-label={c.muted ? `Unmute ${c.name}` : `Mute ${c.name}`}
                        className={`shrink-0 px-2 py-1 text-xs hover:text-fg-body ${
                          c.muted
                            ? 'text-fg-muted'
                            : 'text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        }`}
                      >
                        {c.muted ? <BellOffIcon /> : <BellIcon />}
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>

            <div className={`${SIDEBAR_SUBHEAD_CLASS} mt-2 border-t border-edge pt-2`}>
              <span>Direct messages</span>
              <Tooltip content="Start a DM">
                <button
                  type="button"
                  onClick={() => openDmPicker()}
                  aria-label="Start a DM"
                  className="rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
                >
                  +
                </button>
              </Tooltip>
            </div>

            {dmPicking && (
              <div className="px-2 pb-2">
                <input
                  ref={dmPickerInputRef}
                  value={dmQuery}
                  onChange={(e) => setDmQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    e.stopPropagation();
                    setDmPicking(false);
                  }}
                  placeholder="who?"
                  aria-label="Find a person to message"
                  className="w-full rounded-md border border-edge-strong bg-surface-raised px-2 py-1 text-xs text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
                />
                <ul className="mt-1 max-h-40 overflow-y-auto">
                  {people === null && <li className="px-2 py-1 text-2xs text-fg-muted">loading…</li>}
                  {dmCandidates.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDmIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.id)) next.delete(u.id);
                            else next.add(u.id);
                            return next;
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-fg-secondary hover:bg-surface-overlay"
                      >
                        <Avatar name={u.displayName} seed={u.id} size={16} />
                        <span className="truncate">{u.displayName}</span>
                        <span className="truncate text-fg-muted">@{u.handle}</span>
                        {u.id === me.id && <span className="text-fg-muted">(you)</span>}
                        {selectedDmIds.has(u.id) && <span className="ml-auto text-accent-text-strong">✓</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {selectedDmIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setDmPicking(false);
                      onStartDm([...selectedDmIds]);
                    }}
                    className="mt-2 w-full rounded-md bg-accent-hover px-2 py-1 text-xs font-semibold text-on-accent"
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
                const avatarName = channelAvatarName(c, me.id);
                return (
                  <li key={c.id} className={sidebarItemClass(active, level, c.muted)}>
                    <button type="button" onClick={() => onSelect(c.id)} className={SIDEBAR_ROW_BUTTON_CLASS}>
                      <Avatar name={avatarName} seed={partner?.id ?? c.id} size={16} />
                      <span className="truncate">{label}</span>
                      {unreadBadge(c.id, active)}
                    </button>
                    <Tooltip content={c.muted ? `Unmute ${label}` : `Mute ${label}`}>
                      <button
                        type="button"
                        onClick={() => onSetMute(c.id, !c.muted)}
                        aria-label={c.muted ? `Unmute ${label}` : `Mute ${label}`}
                        className={`shrink-0 px-2 py-1 text-xs hover:text-fg-body ${
                          c.muted
                            ? 'text-fg-muted'
                            : 'text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        }`}
                      >
                        {c.muted ? <BellOffIcon /> : <BellIcon />}
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <SessionSidebarSection
          refreshKey={sessionEventSeq}
          onOpenSession={onOpenSession}
          onOpenAgents={onOpenAgents}
        />
      </div>

      <footer className="relative flex items-center gap-1 border-t border-edge px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-fg-body">{me.displayName}</div>
          <div className="truncate text-2xs text-fg-muted">@{me.handle}</div>
        </div>
        <Tooltip content="Settings">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="rounded-md px-1.5 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
          >
            <GearIcon />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={onLogout}
          className="rounded-md px-2 py-1 text-2xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
        >
          Log out
        </button>
      </footer>
      </nav>
    </>
  );
}

const SESSION_SIDEBAR_PREVIEW_LIMIT = 5;

type SessionListItemAttentionFields = {
  needsAttention?: unknown;
};

function sessionNeedsAttention(session: SessionListItem): boolean {
  return (session as SessionListItem & SessionListItemAttentionFields).needsAttention === true;
}

function sessionSidebarBucket(session: SessionListItem): number {
  if (sessionNeedsAttention(session)) return 0;
  return isTerminalSessionStatus(session.status) ? 2 : 1;
}

function sessionSidebarFreshness(session: SessionListItem): number {
  const timestamp = session.completedAt ?? session.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sessionSidebarPreview(
  sessions: readonly SessionListItem[],
  limit = SESSION_SIDEBAR_PREVIEW_LIMIT,
): SessionListItem[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const bucketDelta = sessionSidebarBucket(a.session) - sessionSidebarBucket(b.session);
      if (bucketDelta !== 0) return bucketDelta;
      const freshnessDelta = sessionSidebarFreshness(b.session) - sessionSidebarFreshness(a.session);
      if (freshnessDelta !== 0) return freshnessDelta;
      return a.index - b.index;
    })
    .slice(0, Math.max(0, limit))
    .map(({ session }) => session);
}

function SessionSidebarSection({
  refreshKey,
  onOpenSession,
  onOpenAgents,
}: {
  refreshKey: number;
  onOpenSession: (sessionId: string) => void;
  onOpenAgents?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

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

  const preview = useMemo(() => sessionSidebarPreview(sessions), [sessions]);
  const open = (id: string) => {
    onOpenSession(id);
  };

  return (
    <>
      <section className="mt-3">
        <h2 className={SIDEBAR_GROUP_TITLE_CLASS}>Agents</h2>
        <div className={SIDEBAR_PANEL_CLASS}>
          <ul>
            {preview.length === 0 && (
              <li className="px-3 py-2 text-xs text-fg-muted">No agent sessions yet</li>
            )}
            {preview.map((session) => (
              <li key={session.id} className="mx-1">
                <button
                  type="button"
                  onClick={() => open(session.id)}
                  className="flex min-h-9 w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-overlay/70"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <StatusChip status={session.status} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-body">
                      {session.title}
                    </span>
                  </span>
                  <span className="truncate pl-1 text-2xs text-fg-faint">#{session.channelName}</span>
                </button>
              </li>
            ))}
            <li className="mx-1">
              <button
                type="button"
                onClick={onOpenAgents}
                className="flex min-h-7 w-full items-center rounded-md px-2 py-1 text-left text-xs font-medium text-accent-text hover:bg-surface-overlay/70"
              >
                View all agent sessions
              </button>
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
