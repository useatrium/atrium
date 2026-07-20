import {
  useEffect,
  memo,
  useMemo,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import { useIsHoverNone } from '../lib/useIsHoverNone';
import { api, type Channel } from '../api';
import { MessageActionMenu, type MessageActionMenuState } from './MessageActionMenu';
import type { ActivityCounts, QueueSyncState } from '@atrium/surface-client';
import type { UnreadLevel, UserRef } from '@atrium/surface-client';
import { channelAvatarName, channelLabel, dmPartner } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { Tooltip } from './a11y';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  FileIcon,
  GearIcon,
  LockIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PinIcon,
  PinOffIcon,
} from './icons';
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from '../storageKeys';
import {
  SIDEBAR_FALLBACK_WIDTH,
  SIDEBAR_MAX_VW,
  SIDEBAR_MIN_WIDTH,
  sidebarSizing,
  useSidebarWidth,
} from '../sessions/useSessionPaneWidth';
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

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function SidebarImpl({
  workspaceName,
  channels,
  activeChannelId,
  unread,
  me,
  wsStatus,
  queueSync,
  onSelect,
  onSetMute,
  onSetArchived,
  onSetPinned,
  onCreateChannel,
  onStartDm,
  activeSurface = 'chat',
  onOpenFiles,
  // === mentions-activity additions ===
  onOpenActivity,
  activityCounts,
  onOpenSettings,
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
  queueSync: QueueSyncState;
  onSelect: (channelId: string) => void;
  onSetMute: (channelId: string, muted: boolean) => void;
  /** Global channel archive toggle; omit to hide the affordance. */
  onSetArchived?: (channelId: string, archived: boolean) => void;
  /** Per-user channel pin toggle; omit to hide the affordance. */
  onSetPinned?: (channelId: string, pinned: boolean) => void;
  onCreateChannel: (name: string, isPrivate?: boolean) => Promise<void>;
  onStartDm: (userIds: string[]) => void;
  activeSurface?: 'chat' | 'files' | 'activity' | 'settings';
  onOpenFiles?: () => void;
  // === mentions-activity additions ===
  onOpenActivity?: () => void;
  activityCounts?: ActivityCounts;
  onOpenSettings?: () => void;
  onLogout: () => void;
  isOpen?: boolean;
  onClose?: () => void;
  createChannelRequestSeq?: number;
  startDmRequestSeq?: number;
}) {
  const { width: sidebarWidth, resizing, startResize, resetWidth, onResizeKeyDown } = useSidebarWidth();
  const sizing = sidebarSizing(sidebarWidth);
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const setDesktopCollapsed = useCallback((next: boolean, transferFocus: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Storage may be unavailable in private mode; the in-memory preference still works.
    }
    if (!transferFocus) return;
    window.requestAnimationFrame(() => {
      (next ? expandButtonRef : collapseButtonRef).current?.focus();
    });
  }, []);
  const sidebarMaxWidth =
    typeof window === 'undefined'
      ? SIDEBAR_FALLBACK_WIDTH
      : Math.max(SIDEBAR_MIN_WIDTH, Math.round((window.innerWidth * SIDEBAR_MAX_VW) / 100));
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
  const channelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const createChannelErrorId = 'sidebar-create-channel-error';
  const isHoverNone = useIsHoverNone();
  const activeChannels = channels.filter((c) => c.archivedAt == null);
  const pinnedChannels = activeChannels.filter((c) => c.pinned);
  const publicChannels = activeChannels.filter((c) => !c.pinned && c.kind !== 'dm' && c.kind !== 'gdm');
  const dms = activeChannels.filter((c) => !c.pinned && (c.kind === 'dm' || c.kind === 'gdm'));
  const archivedChannels = channels.filter((c) => c.archivedAt != null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  // Roving tabindex over the flattened, visible channel rows (across the pinned,
  // channels, DM, and archived groupings). Exactly one row button is tabbable —
  // the active channel's, else the first — and Arrow/Home/End move focus between
  // rows without adding a tab stop per channel.
  const orderedRowChannelIds: string[] = [
    ...pinnedChannels,
    ...publicChannels,
    ...dms,
    ...(archivedOpen ? archivedChannels : []),
  ].map((c) => c.id);
  const [rovingChannelId, setRovingChannelId] = useState<string | null>(null);
  const channelRowRefs = useRef(new Map<string, HTMLButtonElement>());
  // The tabbable row follows the active channel; a manual arrow move overrides it
  // until the active channel changes again.
  useEffect(() => {
    setRovingChannelId(null);
  }, [activeChannelId]);
  const tabbableChannelId =
    rovingChannelId && orderedRowChannelIds.includes(rovingChannelId)
      ? rovingChannelId
      : activeChannelId && orderedRowChannelIds.includes(activeChannelId)
        ? activeChannelId
        : (orderedRowChannelIds[0] ?? null);
  const onChannelRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, channelId: string) => {
    const ids = orderedRowChannelIds;
    const index = ids.indexOf(channelId);
    if (index < 0) return;
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(index + 1, ids.length - 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(index - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextId = ids[nextIndex];
    if (nextId == null) return;
    setRovingChannelId(nextId);
    channelRowRefs.current.get(nextId)?.focus();
  };
  const [channelMenu, setChannelMenu] = useState<{ channel: Channel; state: MessageActionMenuState } | null>(null);
  const openChannelMenu = useCallback(
    (channel: Channel, event: MouseEvent<HTMLButtonElement>) => {
      channelMenuButtonRef.current = event.currentTarget;
      if (isHoverNone) {
        setChannelMenu({ channel, state: { mode: 'sheet' } });
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setChannelMenu({ channel, state: { mode: 'popover', anchor: { x: rect.left, y: rect.bottom + 4 } } });
    },
    [isHoverNone],
  );

  const channelMenuActions = useMemo(() => {
    if (!channelMenu) return [];
    const c = channelMenu.channel;
    const isArchived = c.archivedAt != null;
    return [
      ...(onSetPinned && !isArchived
        ? [{ key: 'pin', label: c.pinned ? 'Unpin' : 'Pin', onSelect: () => onSetPinned(c.id, !c.pinned) }]
        : []),
      ...(onSetArchived
        ? [
            {
              key: 'archive',
              label: isArchived ? 'Unarchive' : 'Archive',
              onSelect: () => onSetArchived(c.id, !isArchived),
            },
          ]
        : []),
      { key: 'mute', label: c.muted ? 'Unmute' : 'Mute', onSelect: () => onSetMute(c.id, !c.muted) },
    ];
  }, [channelMenu, onSetArchived, onSetMute, onSetPinned]);
  const syncTitle = `Syncing — ${queueSync.queuedCount} ${queueSync.queuedCount === 1 ? 'change' : 'changes'} queued`;
  const connectionDotTitle = wsStatus === 'open' && queueSync.syncStuck ? syncTitle : `connection: ${wsStatus}`;
  const connectionDotClass =
    wsStatus === 'open'
      ? queueSync.syncStuck
        ? 'animate-pulse bg-info'
        : 'bg-transparent'
      : wsStatus === 'connecting'
        ? 'animate-pulse bg-warning'
        : 'bg-danger';

  const loadPeople = useCallback(() => {
    if (people !== null) return;
    api
      .users()
      .then(({ users }) => setPeople(users))
      .catch(() => setPeople([]));
  }, [people]);

  const openDmPicker = useCallback(
    (forceOpen = false) => {
      setDmPicking((v) => (forceOpen ? true : !v));
      setDmQuery('');
      setSelectedDmIds(new Set());
      loadPeople();
    },
    [loadPeople],
  );
  const dmCandidates = (people ?? []).filter(
    (u) =>
      u.handle.toLowerCase().includes(dmQuery.trim().toLowerCase()) ||
      u.displayName.toLowerCase().includes(dmQuery.trim().toLowerCase()),
  );

  const unreadBadge = (channelId: string, active: boolean) => {
    if (channels.find((c) => c.id === channelId)?.muted) return null;
    const level = active ? false : (unread[channelId] ?? false);
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

  const inboxBadge = () => {
    const unreadCount = activityCounts?.unread ?? 0;
    if (unreadCount <= 0) return null;
    return (
      <span className="ml-auto shrink-0 rounded-full bg-surface-overlay px-1.5 py-px text-3xs font-bold leading-4 text-fg-muted">
        {unreadCount >= 99 ? '99+' : unreadCount}
        <span className="sr-only"> unread activity</span>
      </span>
    );
  };

  const renderChannelRow = (c: Channel) => {
    const active = c.id === activeChannelId;
    const level = c.muted || active ? false : (unread[c.id] ?? false);
    const isDm = c.kind === 'dm' || c.kind === 'gdm';
    const label = isDm ? channelLabel(c, me.id) : c.name;
    const partner = isDm ? dmPartner(c, me.id) : null;
    const isArchived = c.archivedAt != null;
    return (
      <li key={c.id} className={sidebarItemClass(active, level, c.muted)}>
        <button
          type="button"
          ref={(el) => {
            if (el) channelRowRefs.current.set(c.id, el);
            else channelRowRefs.current.delete(c.id);
          }}
          onClick={() => onSelect(c.id)}
          onKeyDown={(event) => onChannelRowKeyDown(event, c.id)}
          tabIndex={tabbableChannelId === c.id ? 0 : -1}
          aria-current={active ? 'page' : undefined}
          className={SIDEBAR_ROW_BUTTON_CLASS}
        >
          {isDm ? (
            <Avatar name={channelAvatarName(c, me.id)} seed={partner?.id ?? c.id} src={partner?.avatarUrl} size={16} />
          ) : (
            <span className="grid w-4 shrink-0 place-items-center text-fg-muted">
              {c.kind === 'private' ? <LockIcon size={14} /> : '#'}
            </span>
          )}
          <span className="truncate">{label}</span>
          {unreadBadge(c.id, active)}
        </button>
        {onSetPinned && !isArchived && (
          <Tooltip content={c.pinned ? `Unpin ${label}` : `Pin ${label}`}>
            <button
              type="button"
              onClick={() => onSetPinned(c.id, !c.pinned)}
              aria-label={c.pinned ? `Unpin ${label}` : `Pin ${label}`}
              className="hidden shrink-0 px-1 py-1 text-xs text-fg-faint opacity-0 hover:text-fg-body group-hover:opacity-100 focus-visible:opacity-100 @[12rem]:block max-md:opacity-100 [@media(hover:none)]:opacity-100"
            >
              {c.pinned ? <PinOffIcon /> : <PinIcon />}
            </button>
          </Tooltip>
        )}
        {onSetArchived && (
          <Tooltip content={isArchived ? `Unarchive ${label}` : `Archive ${label}`}>
            <button
              type="button"
              onClick={() => onSetArchived(c.id, !isArchived)}
              aria-label={isArchived ? `Unarchive ${label}` : `Archive ${label}`}
              className="hidden shrink-0 px-1 py-1 text-xs text-fg-faint opacity-0 hover:text-fg-body group-hover:opacity-100 focus-visible:opacity-100 @[15.5rem]:block max-md:opacity-100 [@media(hover:none)]:opacity-100"
            >
              {isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={c.muted ? `Unmute ${label}` : `Mute ${label}`}>
          <button
            type="button"
            onClick={() => onSetMute(c.id, !c.muted)}
            aria-label={c.muted ? `Unmute ${label}` : `Mute ${label}`}
            className={`shrink-0 px-2 py-1 text-xs hover:text-fg-body ${
              c.muted
                ? 'text-fg-muted'
                : 'text-fg-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100'
            }`}
          >
            {c.muted ? <BellOffIcon /> : <BellIcon />}
          </button>
        </Tooltip>
        <Tooltip content={`More actions for ${isDm ? label : `#${label}`}`}>
          <button
            type="button"
            onClick={(event) => openChannelMenu(c, event)}
            aria-label={`More actions for ${isDm ? label : `#${label}`}`}
            aria-haspopup="dialog"
            aria-expanded={channelMenu?.channel.id === c.id}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold leading-none text-fg-faint opacity-0 hover:bg-surface-overlay hover:text-fg-body group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:inline-flex [@media(hover:none)]:size-11 [@media(hover:none)]:items-center [@media(hover:none)]:justify-center [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100"
          >
            ⋯
          </button>
        </Tooltip>
      </li>
    );
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
        className={`fixed inset-0 z-overlay bg-black/50 motion-safe:transition-opacity md:hidden ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <nav
        data-testid="sidebar"
        data-collapsed={collapsed || undefined}
        className={`fixed inset-y-0 left-0 z-overlay flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-edge bg-surface-raised shadow-2xl motion-safe:transition-transform motion-reduce:transition-none md:relative md:z-auto md:max-w-none md:translate-x-0 md:bg-surface-raised md:shadow-none md:transition-[width] md:duration-200 motion-reduce:md:transition-none ${
          collapsed ? 'md:w-13' : 'md:w-(--sidebar-w)'
        } ${isOpen ? 'translate-x-0' : '-translate-x-full'} ${sizing.className}`}
        style={{ '--sidebar-w': '224px', ...sizing.style } as CSSProperties}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: resizable pane separator uses a div for pointer capture and custom sizing. */}
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={sidebarMaxWidth}
          aria-valuenow={sidebarWidth ?? SIDEBAR_FALLBACK_WIDTH}
          title="Drag to resize · double-click to reset"
          data-testid="sidebar-resize-handle"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          onKeyDown={onResizeKeyDown}
          className={`absolute inset-y-0 -right-0.5 z-raised w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-accent max-md:hidden ${
            collapsed ? 'md:hidden' : ''
          } ${resizing ? 'bg-accent/50' : ''}`}
        />
        <header
          className={`flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4 ${collapsed ? 'md:hidden' : ''}`}
        >
          <span className="truncate text-sm font-bold tracking-tight text-fg">{workspaceName}</span>
          <span
            role="status"
            aria-label={`connection: ${wsStatus}`}
            title={connectionDotTitle}
            className={`ml-auto size-2 shrink-0 rounded-full ${connectionDotClass}`}
          >
            <span className="sr-only">connection: {wsStatus}</span>
          </span>
          <Tooltip content="Collapse navigation">
            <button
              ref={collapseButtonRef}
              type="button"
              onClick={(event) => setDesktopCollapsed(true, event.detail === 0)}
              aria-label="Collapse navigation"
              className="hidden size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent md:inline-flex"
            >
              <PanelLeftCloseIcon size={14} />
            </button>
          </Tooltip>
        </header>

        {collapsed && (
          <div data-testid="sidebar-collapsed-rail" className="hidden min-h-0 flex-1 flex-col items-center md:flex">
            <div className="flex h-12 w-full shrink-0 items-center justify-center border-b border-edge">
              <Tooltip content={`Expand navigation · ${workspaceName}`} side="right">
                <button
                  ref={expandButtonRef}
                  type="button"
                  onClick={(event) => setDesktopCollapsed(false, event.detail === 0)}
                  aria-label="Expand navigation"
                  className="relative grid size-9 place-items-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="text-xs font-bold text-fg">
                    {workspaceName.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <PanelLeftOpenIcon size={12} className="absolute -bottom-0.5 -right-0.5 text-fg-muted" />
                  <span
                    role="status"
                    aria-label={`connection: ${wsStatus}`}
                    className={`absolute -left-0.5 -top-0.5 size-2 rounded-full ${connectionDotClass}`}
                  />
                </button>
              </Tooltip>
            </div>
            <div className="flex w-full flex-col items-center gap-1 py-2">
              <Tooltip content="Inbox" side="right">
                <button
                  type="button"
                  aria-current={activeSurface === 'activity' ? 'page' : undefined}
                  onClick={onOpenActivity}
                  aria-label={activityCounts?.unread ? `Inbox, ${activityCounts.unread} unread` : 'Inbox'}
                  className={`relative grid size-10 place-items-center rounded-md text-sm font-bold ${
                    activeSurface === 'activity'
                      ? 'bg-accent/20 text-fg'
                      : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'
                  }`}
                >
                  @
                  {(activityCounts?.unread ?? 0) > 0 && (
                    <span className="absolute right-1 top-1 size-2 rounded-full bg-danger-strong" aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
              <Tooltip content="Files" side="right">
                <button
                  type="button"
                  aria-current={activeSurface === 'files' ? 'page' : undefined}
                  onClick={onOpenFiles}
                  aria-label="Files"
                  className={`grid size-10 place-items-center rounded-md ${
                    activeSurface === 'files'
                      ? 'bg-accent/20 text-fg'
                      : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'
                  }`}
                >
                  <FileIcon size={16} />
                </button>
              </Tooltip>
            </div>
            <div className="mt-auto w-full border-t border-edge py-2">
              <Tooltip content="Settings" side="right">
                <button
                  type="button"
                  aria-current={activeSurface === 'settings' ? 'page' : undefined}
                  onClick={onOpenSettings}
                  aria-label="Settings"
                  className={`mx-auto grid size-10 place-items-center rounded-md ${
                    activeSurface === 'settings'
                      ? 'bg-accent/20 text-fg'
                      : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'
                  }`}
                >
                  <GearIcon size={16} />
                </button>
              </Tooltip>
            </div>
          </div>
        )}

        <div className={`@container flex-1 overflow-y-auto px-2 py-3 ${collapsed ? 'md:hidden' : ''}`}>
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
                <span
                  aria-hidden="true"
                  className="grid w-4 shrink-0 place-items-center text-xs font-bold text-fg-muted"
                >
                  @
                </span>
                <span className="truncate">Inbox</span>
                {inboxBadge()}
              </button>
            </div>
          </section>

          <section className="mt-3">
            <h2 className={SIDEBAR_GROUP_TITLE_CLASS}>Conversations</h2>
            <div className={SIDEBAR_PANEL_CLASS}>
              {pinnedChannels.length > 0 && (
                <>
                  <div className={SIDEBAR_SUBHEAD_CLASS}>
                    <span>Pinned</span>
                  </div>
                  <ul className="pb-1">{pinnedChannels.map(renderChannelRow)}</ul>
                </>
              )}
              <div
                className={`${SIDEBAR_SUBHEAD_CLASS}${pinnedChannels.length > 0 ? ' mt-2 border-t border-edge pt-2' : ''}`}
              >
                <span>Channels</span>
                <Tooltip content="Create channel">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating((v) => !v);
                      setError(null);
                    }}
                    aria-label="Create channel"
                    className="grid min-h-6 min-w-6 place-items-center rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
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
                  {error && (
                    <div id={createChannelErrorId} role="alert" className="pt-1 text-2xs text-danger">
                      {error}
                    </div>
                  )}
                </form>
              )}

              <ul className="max-h-80 overflow-y-auto pb-1">{publicChannels.map(renderChannelRow)}</ul>

              <div className={`${SIDEBAR_SUBHEAD_CLASS} mt-2 border-t border-edge pt-2`}>
                <span>Direct messages</span>
                <Tooltip content="Start a DM">
                  <button
                    type="button"
                    onClick={() => openDmPicker()}
                    aria-label="Start a DM"
                    className="grid min-h-6 min-w-6 place-items-center rounded px-1.5 text-sm leading-5 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
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
                          <Avatar name={u.displayName} seed={u.id} src={u.avatarUrl} size={16} />
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

              <ul>{dms.map(renderChannelRow)}</ul>

              {archivedChannels.length > 0 && (
                <div className="mt-2 border-t border-edge pt-1">
                  <button
                    type="button"
                    onClick={() => setArchivedOpen((open) => !open)}
                    aria-expanded={archivedOpen}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-2xs font-semibold text-fg-muted hover:text-fg-secondary"
                  >
                    <span aria-hidden className="inline-block w-2.5 text-center">
                      {archivedOpen ? '▾' : '▸'}
                    </span>
                    <span>Archived</span>
                    <span className="tabular-nums text-fg-faint">{archivedChannels.length}</span>
                  </button>
                  {archivedOpen && <ul className="pb-1">{archivedChannels.map(renderChannelRow)}</ul>}
                </div>
              )}
            </div>
          </section>
        </div>

        <footer
          className={`relative flex items-center gap-1 border-t border-edge px-4 py-2.5 ${
            collapsed ? 'md:hidden' : ''
          }`}
        >
          <Avatar name={me.displayName} seed={me.id} src={me.avatarUrl} size={24} />
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
      <MessageActionMenu
        state={channelMenu?.state ?? null}
        onClose={() => setChannelMenu(null)}
        restoreFocusRef={channelMenuButtonRef}
        actions={channelMenuActions}
        label="Channel actions"
      />
    </>
  );
}

export const Sidebar = memo(SidebarImpl);
