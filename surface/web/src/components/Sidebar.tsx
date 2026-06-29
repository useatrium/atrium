import {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  api,
  type Channel,
  type ConnectionStatus,
  type ProviderCredentialProvider,
  type ProviderCredentialStatus,
} from '../api';
import {
  ACCENTS,
  FONT_SCALES,
  formatCost,
  formatTime,
  isTerminalSessionStatus,
  type Accent,
  type FontScale,
  type MotionPref,
  type SessionListItem,
  type ThemeMode,
} from '@atrium/surface-client';
import { notificationState, toggleNotifications, type NotifyState } from '../notify';
import type { UnreadLevel, UserRef } from '@atrium/surface-client';
import { channelAvatarName, channelLabel, dmPartner } from '@atrium/surface-client';
import { sessionsApi } from '../sessions/api';
import { StatusChip } from '../sessions/SessionCard';
import { useTheme } from '../theme';
import { Avatar } from './Avatar';
import { BellIcon, BellOffIcon, GearIcon, LockIcon } from './icons';
import { useDialog } from '../useDialog';

const BELL_TITLES: Record<NotifyState, string> = {
  on: 'Notifications on (mentions + your sessions) — click to turn off',
  off: 'Notifications off — click to enable',
  denied: 'Notifications blocked in browser settings',
  unsupported: 'Notifications not supported here',
};

const SOURCE_URL = 'https://github.com/gbasin/atrium';
const LICENSE_URL = `${SOURCE_URL}/blob/master/LICENSE`;

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
  githubConnection,
  connectionsAvailable = true,
  providerCredentials,
  onConnectGitHub,
  onConnectProvider,
  onLogout,
  isOpen = false,
  onClose,
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
  githubConnection?: ConnectionStatus;
  connectionsAvailable?: boolean;
  providerCredentials?: Record<string, ProviderCredentialStatus | undefined>;
  onConnectGitHub?: () => void;
  onConnectProvider?: (provider: ProviderCredentialProvider) => void;
  onLogout: () => void;
  isOpen?: boolean;
  onClose?: () => void;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);
  const firstSettingsControlRef = useRef<HTMLButtonElement | null>(null);

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

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  useDialog({
    open: settingsOpen,
    containerRef: settingsPopoverRef,
    initialFocusRef: firstSettingsControlRef,
    invokerRef: settingsButtonRef,
    closeOnOutsidePointer: true,
    onClose: closeSettings,
  });

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
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-edge bg-surface-raised shadow-2xl motion-safe:transition-transform motion-reduce:transition-none md:static md:z-auto md:w-56 md:max-w-none md:translate-x-0 md:bg-surface-raised/50 md:shadow-none md:transition-none ${
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

      <div className="flex-1 overflow-y-auto py-3">
        <div className="flex items-center justify-between px-4 pb-1">
          <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
            Channels
          </h2>
          <button
            onClick={() => {
              setCreating((v) => !v);
              setError(null);
            }}
            title="Create channel"
            aria-label="Create channel"
            className="rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
          >
            +
          </button>
        </div>

        {creating && (
          <form onSubmit={submit} className="px-3 pb-2">
            <input
              autoFocus
              value={name}
              aria-label="Channel name"
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
            {error && <div role="alert" className="pt-1 text-2xs text-danger">{error}</div>}
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
                      ? 'bg-accent/20 font-medium text-fg'
                      : level
                        ? 'font-semibold text-fg hover:bg-surface-overlay/70'
                        : c.muted
                          ? 'text-fg-faint hover:bg-surface-overlay/70 hover:text-fg-muted'
                          : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
                  }`}
                >
                  <span className="text-fg-muted">
                    {c.kind === 'private' ? <LockIcon size={14} /> : '#'}
                  </span>
                  <span className="truncate">{c.name}</span>
                  {unreadBadge(c.id, active)}
                </button>
                <button
                  onClick={() => onSetMute(c.id, !c.muted)}
                  title={c.muted ? 'Unmute channel' : 'Mute channel'}
                  aria-label={c.muted ? `Unmute ${c.name}` : `Mute ${c.name}`}
                  className={`shrink-0 px-3 py-1 text-xs hover:bg-surface-overlay hover:text-fg-body ${
                    c.muted ? 'text-fg-muted' : 'text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  }`}
                >
                  {c.muted ? <BellOffIcon /> : <BellIcon />}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center justify-between px-4 pb-1">
          <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
            Direct messages
          </h2>
          <button
            onClick={openDmPicker}
            title="Start a DM"
            aria-label="Start a DM"
            className="rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
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
              className="w-full rounded-md border border-edge-strong bg-surface-raised px-2 py-1 text-xs text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
            />
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {people === null && <li className="px-2 py-1 text-2xs text-fg-muted">loading…</li>}
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
              <li key={c.id} className="group flex items-center">
                <button
                  onClick={() => onSelect(c.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 py-1 pl-4 text-left text-sm ${
                    active
                      ? 'bg-accent/20 font-medium text-fg'
                      : level
                        ? 'font-semibold text-fg hover:bg-surface-overlay/70'
                        : c.muted
                          ? 'text-fg-faint hover:bg-surface-overlay/70 hover:text-fg-muted'
                          : 'text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-body'
                  }`}
                >
                  <Avatar name={avatarName} seed={partner?.id ?? c.id} size={16} />
                  <span className="truncate">{label}</span>
                  {unreadBadge(c.id, active)}
                </button>
                <button
                  onClick={() => onSetMute(c.id, !c.muted)}
                  title={c.muted ? 'Unmute DM' : 'Mute DM'}
                  aria-label={c.muted ? `Unmute ${label}` : `Mute ${label}`}
                  className={`shrink-0 px-3 py-1 text-xs hover:bg-surface-overlay hover:text-fg-body ${
                    c.muted ? 'text-fg-muted' : 'text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  }`}
                >
                  {c.muted ? <BellOffIcon /> : <BellIcon />}
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

      <footer className="relative flex items-center gap-1 border-t border-edge px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-fg-body">{me.displayName}</div>
          <div className="truncate text-2xs text-fg-muted">@{me.handle}</div>
        </div>
        <button
          ref={settingsButtonRef}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Settings"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          className="rounded-md px-1.5 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
        >
          <GearIcon />
        </button>
        {settingsOpen && (
          <SettingsPopover
            refEl={settingsPopoverRef}
            firstControlRef={firstSettingsControlRef}
            notify={notify}
            setNotify={setNotify}
            githubConnection={githubConnection}
            connectionsAvailable={connectionsAvailable}
            claudeStatus={providerCredentials?.['claude-code']}
            codexStatus={providerCredentials?.codex}
            onConnectGitHub={onConnectGitHub}
            onConnectClaude={() => onConnectProvider?.('claude-code')}
            onConnectCodex={() => onConnectProvider?.('codex')}
          />
        )}
        <button
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

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

const ACCENT_LABELS: Record<Accent, string> = {
  indigo: 'Indigo',
  teal: 'Teal',
  amber: 'Amber',
  rose: 'Rose',
};

const FONT_LABELS: Record<FontScale, string> = {
  0.875: 'S',
  1: 'M',
  1.125: 'L',
  1.25: 'XL',
};

const SWATCH_CLASSES: Record<Accent, string> = {
  indigo: 'accent-swatch-indigo',
  teal: 'accent-swatch-teal',
  amber: 'accent-swatch-amber',
  rose: 'accent-swatch-rose',
};

function SettingsPopover({
  refEl,
  firstControlRef,
  notify,
  setNotify,
  githubConnection,
  connectionsAvailable,
  claudeStatus,
  codexStatus,
  onConnectGitHub,
  onConnectClaude,
  onConnectCodex,
}: {
  refEl: RefObject<HTMLDivElement | null>;
  firstControlRef: RefObject<HTMLButtonElement | null>;
  notify: NotifyState;
  setNotify: (state: NotifyState) => void;
  githubConnection?: ConnectionStatus;
  connectionsAvailable: boolean;
  claudeStatus?: ProviderCredentialStatus;
  codexStatus?: ProviderCredentialStatus;
  onConnectGitHub?: () => void;
  onConnectClaude?: () => void;
  onConnectCodex?: () => void;
}) {
  const { prefs, setPrefs } = useTheme();
  const segmentButton = (active: boolean) =>
    `h-8 flex-1 rounded px-2 text-xs font-medium ${
      active
        ? 'bg-accent text-on-accent'
        : 'text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body'
    }`;

  return (
    <div
      ref={refEl}
      role="dialog"
      aria-label="Settings"
      className="absolute bottom-full left-2 z-40 mb-2 w-72 rounded-md border border-edge-strong bg-surface-raised p-3 shadow-2xl"
    >
      <div className="space-y-3">
        <SettingRow label="Theme">
          <div className="flex rounded-md border border-edge bg-surface p-0.5">
            {THEME_OPTIONS.map((option, index) => (
              <button
                key={option.value}
                ref={index === 0 ? firstControlRef : undefined}
                type="button"
                aria-pressed={prefs.theme === option.value}
                onClick={() => setPrefs({ theme: option.value })}
                className={segmentButton(prefs.theme === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Accent">
          <div className="flex items-center gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                type="button"
                aria-label={`${ACCENT_LABELS[accent]} accent`}
                title={ACCENT_LABELS[accent]}
                aria-pressed={prefs.accent === accent}
                onClick={() => setPrefs({ accent })}
                className={`flex size-8 items-center justify-center rounded-md border border-edge ${
                  prefs.accent === accent ? 'ring-2 ring-accent-text ring-offset-1 ring-offset-surface-raised' : ''
                }`}
              >
                <span className={`size-4 rounded-full ${SWATCH_CLASSES[accent]}`} />
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Text size">
          <div className="grid grid-cols-4 rounded-md border border-edge bg-surface p-0.5">
            {FONT_SCALES.map((fontScale) => (
              <button
                key={fontScale}
                type="button"
                aria-label={`${FONT_LABELS[fontScale]} text size`}
                aria-pressed={prefs.fontScale === fontScale}
                onClick={() => setPrefs({ fontScale })}
                className={segmentButton(prefs.fontScale === fontScale)}
              >
                {FONT_LABELS[fontScale]}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="High contrast">
          <button
            type="button"
            aria-label="High contrast"
            aria-pressed={prefs.highContrast}
            onClick={() => setPrefs({ highContrast: !prefs.highContrast })}
            className={`flex h-8 w-16 items-center rounded-full border px-1 ${
              prefs.highContrast
                ? 'justify-end border-accent bg-accent text-on-accent'
                : 'justify-start border-edge-strong bg-surface text-fg-muted'
            }`}
          >
            <span className="size-5 rounded-full bg-current" />
          </button>
        </SettingRow>

        <SettingRow label="Motion">
          <div className="flex rounded-md border border-edge bg-surface p-0.5">
            {MOTION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={prefs.motion === option.value}
                onClick={() => setPrefs({ motion: option.value })}
                className={segmentButton(prefs.motion === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Notifications">
          <button
            type="button"
            onClick={() => {
              void toggleNotifications().then(setNotify);
            }}
            disabled={notify === 'denied' || notify === 'unsupported'}
            title={BELL_TITLES[notify]}
            aria-label={BELL_TITLES[notify]}
            aria-pressed={notify === 'on'}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body disabled:opacity-40"
          >
            {notify === 'on' ? <BellIcon /> : <BellOffIcon />}
            <span>{notify === 'on' ? 'On' : notify === 'off' ? 'Off' : 'Blocked'}</span>
          </button>
        </SettingRow>

        <SettingRow label="GitHub">
          <button
            type="button"
            onClick={onConnectGitHub}
            title={connectionsAvailable ? 'Manage GitHub connection' : 'GitHub connections unavailable'}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            <span
              className={`size-2 rounded-full ${
                githubConnection?.connected ? 'bg-success' : connectionsAvailable ? 'bg-warning' : 'bg-fg-muted/60'
              }`}
            />
            <span>
              {githubConnection?.connected
                ? githubConnection.accountLabel ?? 'Connected'
                : connectionsAvailable
                  ? 'Connect'
                  : 'Unavailable'}
            </span>
          </button>
        </SettingRow>

        <SettingRow label="Claude Code">
          <button
            type="button"
            onClick={onConnectClaude}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            <span
              className={`size-2 rounded-full ${
                claudeStatus?.connected ? 'bg-success' : 'bg-warning'
              }`}
            />
            <span>{claudeStatus?.connected ? 'Connected' : 'Connect'}</span>
          </button>
        </SettingRow>

        <SettingRow label="Codex">
          <button
            type="button"
            onClick={onConnectCodex}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            <span
              className={`size-2 rounded-full ${
                codexStatus?.connected ? 'bg-success' : 'bg-warning'
              }`}
            />
            <span>{codexStatus?.connected ? 'Connected' : 'Connect'}</span>
          </button>
        </SettingRow>

        <div className="border-t border-edge pt-3 text-2xs leading-5 text-fg-muted">
          Atrium is AGPL-3.0-or-later.{' '}
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            Source
          </a>
          {' · '}
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            License
          </a>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
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
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
          Sessions
        </h2>
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-3xs font-semibold tabular-nums text-fg-tertiary">
          {running.length}
        </span>
      </div>
      <ul>
        {preview.map((session) => (
          <li key={session.id}>
            <button
              onClick={() => open(session.id)}
              className="flex w-full min-w-0 flex-col gap-1 px-4 py-1.5 text-left hover:bg-surface-overlay/70"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusChip status={session.status} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-body">
                  {session.title}
                </span>
              </span>
              <span className="truncate pl-1 text-2xs text-fg-faint">
                #{session.channelName}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            onClick={() => setModalOpen(true)}
            className="w-full px-4 py-1 text-left text-xs font-medium text-accent-text hover:bg-surface-overlay/70"
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialog({ open: true, containerRef: dialogRef, onClose });

  return (
    <div
      className="fixed inset-0 z-50 bg-surface/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Browse sessions"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-24 w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <h2 className="border-b border-edge px-3 py-2.5 text-sm font-semibold text-fg">
          Sessions
        </h2>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onOpenSession(session.id)}
              className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-accent/20"
            >
              <StatusChip status={session.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">
                  {session.title}
                </span>
                <span className="block truncate text-2xs text-fg-muted">
                  #{session.channelName} · {session.spawnerName} · {formatTime(session.createdAt)}
                </span>
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
                {session.costUsd > 0 ? formatCost(session.costUsd) : ''}
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-fg-muted">No sessions yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
