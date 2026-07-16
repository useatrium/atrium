import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, type Workspace, api } from './api';
import { isDesktop, isMacDesktop, desktopWsUrl, setDesktopBadge } from './desktop';
import {
  DurableOpQueue,
  FILES_CHANGED_EVENT_TYPE,
  appReducer,
  connectionHost,
  filesChangedWorkspaceId,
  dispatchSyncSnapshot,
  dispatchSyncResponse,
  initialAppState,
  newestConfirmedMainEventId,
  randomId,
  reconnectingLabel,
  type EnqueueOpInput,
  type OpType,
  type QueueSyncState,
  useQueueSyncState,
  wsStatusKind,
  type WsStatus,
} from '@atrium/surface-client';
import { showNotification } from './notify';
import {
  emptyTimeline,
  mentionsHandle,
  sessionAttentionKind,
  type ActivityChannelCounts,
  type ActivityCounts,
  type ActivityItem,
  type Channel,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';
import { useWs } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { Avatar } from './components/Avatar';
import { AgentsSurface } from './components/AgentsSurface';
import { ActivityView } from './components/ActivityView';
import { labelForCallChannel, userForCall } from './callPresentation';
import { notificationForWireEvent } from './chatNotifications';
import { ChannelMembersMenu } from './components/ChannelMembersMenu';
import { CallNotice, ChannelCallStrip, InCallPanel, IncomingCallBanner } from './components/CallUI';
import { ClaudeConnectDialog } from './components/ClaudeConnectDialog';
import { CodexConnectDialog } from './components/CodexConnectDialog';
import { Composer, type ComposerHandle } from './components/Composer';
import { GitHubConnectionDialog } from './components/GitHubConnectionDialog';
import { EntryQuoteApplyContextProvider } from './components/EntryQuoteCard';
import { ShortcutsHelp, Tooltip } from './components/a11y';
import { FileIcon, GearIcon, LockIcon, PhoneIcon, PlayIcon, PlusIcon, SearchIcon, XIcon } from './components/icons';
import { splitMarkdownFrontmatter } from '@atrium/surface-client';
import { MarkupPane, type MarkupPaneMode, type MarkupPaneSource } from './components/MarkupPane';
import { showErrorToast } from './components/Toasts';
import { QuickSwitcher, type QuickSwitcherCommand } from './components/QuickSwitcher';
import { SettingsSurface } from './components/SettingsSurface';
import { Sidebar } from './components/Sidebar';
// === spine additions === Thread strips can open the pane directly on a work tab.
import type { SpineOpenSessionOptions } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';
import { sessionsApi } from './sessions/api';
import { Gallery } from './sessions/Gallery';
import type { TranscriptDiscussPayload } from './sessions/SessionPane';
import { ConversationPanel } from './sessions/ConversationPanel';
// === spine additions === Reuse SessionPane's canonical work-tab URL grammar.
import { TAB_SLUG } from './sessions/WorkDrawer';
import { loadSessionPaneWidth, sessionPaneSizing } from './sessions/useSessionPaneWidth';
import { ChannelStrip } from './sessions/ChannelStrip';
import { SpawnDialog } from './sessions/SpawnDialog';
import { ViewToggle } from './sessions/ViewToggle';
import { isPendingSessionId, isTerminalSessionStatus, sessionFromWire } from './sessions/types';
import { adoptPrefs, useTheme } from './theme';
import { channelAvatarName, channelLabel, dmPartner } from '@atrium/surface-client';
import { clearCache, eventCache } from './cacheIdb';
import { hydrateCachedTimelines } from './hydration';
import { useAgentProfiles } from './useAgentProfiles';
import { useCall } from './useCall';
import { useCallsAvailable } from './useCallsAvailable';
import {
  QUEUE_NUDGE_KEY,
  broadcastQueueNudge,
  createChatOpRegistry,
  createQueueLockProvider,
  queuedFailureMessage,
} from './chatQueue';
import { queuedOverlayAction } from './chatQueuedOverlays';
import { useChannelActions } from './useChannelActions';
import { useChatMessageActions } from './useChatMessageActions';
import { useDraftState } from './useDraftState';
import { useConnections } from './useConnections';
import { useProviderCredentials } from './useProviderCredentials';
import { useReadMarks } from './useReadMarks';
import { useSessionActions } from './useSessionActions';
import { useSessionPaneState } from './useSessionPaneState';
import { useSessionQueueFailures } from './useSessionQueueFailures';
import { useTypingIndicators } from './useTypingIndicators';
import { useUploadQueue } from './useUploadQueue';
import { entryParamFromSearch, stripEntryParamFromLocation, threadRootParamFromSearch } from './EntryLinkRoute';
import { SHORTCUTS, matchesChord } from './lib/shortcuts';
import {
  URL_PARAMS,
  navigate,
  parseInAppRoute,
  routePath,
  useLocation,
  type InAppRoute,
  type MainSurface,
} from './router';

const PAGE_SIZE = 50;
const SYNC_LIMIT = 500;
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
const browserWsUrl = import.meta.env.VITE_ATRIUM_WS_URL?.trim();

type QueueStatusBanner = {
  text: string;
  title?: string;
};

function queuedReconnectTitle(queuedCount: number): string | undefined {
  if (queuedCount <= 0) return undefined;
  return `${queuedCount} ${queuedCount === 1 ? 'change' : 'changes'} will send when reconnected`;
}

export function queueStatusBanner(
  wsStatus: WsStatus,
  queueSync: QueueSyncState,
  host = 'server',
): QueueStatusBanner | null {
  const text = reconnectingLabel(wsStatus, host);
  if (!text) return null;
  return {
    text,
    title: queuedReconnectTitle(queueSync.queuedCount),
  };
}

// === web-client additions ===
type NotificationClickTarget = {
  channelId?: string;
  eventId?: string | number;
  sessionId?: string;
  threadRootId?: string | number;
};

function notificationThreadRootId(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function notificationClickTarget(input: unknown): NotificationClickTarget | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const channelId = typeof raw.channelId === 'string' ? raw.channelId : undefined;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  const eventId = typeof raw.eventId === 'string' || typeof raw.eventId === 'number' ? raw.eventId : undefined;
  const threadRootId =
    typeof raw.threadRootId === 'string' || typeof raw.threadRootId === 'number' ? raw.threadRootId : undefined;
  if (!channelId && !sessionId && eventId === undefined && threadRootId === undefined) return null;
  return {
    ...(channelId ? { channelId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(threadRootId !== undefined ? { threadRootId } : {}),
  };
}

export function applyUnreadBadges(unreadCount: number): void {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & {
          setAppBadge?: (contents?: number) => Promise<void>;
          clearAppBadge?: () => Promise<void>;
        })
      : null;
  if (nav && unreadCount > 0 && typeof nav.setAppBadge === 'function') {
    void nav.setAppBadge(unreadCount).catch(() => {});
  } else if (nav && unreadCount <= 0 && typeof nav.clearAppBadge === 'function') {
    void nav.clearAppBadge().catch(() => {});
  }
  setDesktopBadge(unreadCount);
}

const ACTIVITY_SESSION_EVENT_TYPES = new Set([
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
  'session.provider_auth_required',
  'session.github_auth_required',
  'session.provider_auth_resolved',
  'session.completed',
  'session.status_changed',
]);

/** True when a live event can change this user's Inbox feed or its attention state. */
export function isActivityRefreshEvent(
  event: WireEvent,
  me: UserRef,
  channels: readonly Channel[],
  sessions: Record<string, { spawnedBy: string }>,
): boolean {
  if (event.type === 'call.ended') {
    if (!event.channelId || !event.actorId || event.actorId === me.id) return false;
    const channel = channels.find((candidate) => candidate.id === event.channelId);
    return channel?.kind === 'dm' || channel?.kind === 'gdm';
  }

  if (event.type === 'message.posted') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (mentionsHandle(text, me.handle)) return true;
    if (!event.actorId || event.actorId === me.id) return false;
    const channel = event.channelId ? channels.find((candidate) => candidate.id === event.channelId) : null;
    if (channel?.kind === 'dm' || channel?.kind === 'gdm') return true;
    // The server knows the full participant history, which may predate this
    // client's loaded timeline. Refreshing other people's thread replies is
    // therefore the safe way to avoid missing a newly relevant one.
    return event.threadRootEventId != null;
  }

  if (!ACTIVITY_SESSION_EVENT_TYPES.has(event.type)) return false;
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null;
  return !!sessionId && sessions[sessionId]?.spawnedBy === me.id;
}
// === web-client additions ===

type EnqueueOpOptions = {
  onStored?: () => void;
};

function channelsWithAdvancedReadCursor(
  channels: Channel[],
  channelId: string,
  lastReadEventId: number,
): { channels: Channel[]; advanced: boolean } {
  let advanced = false;
  const next = channels.map((channel) => {
    if (channel.id !== channelId || (channel.lastReadEventId ?? 0) >= lastReadEventId) return channel;
    advanced = true;
    return { ...channel, lastReadEventId };
  });
  return { channels: advanced ? next : channels, advanced };
}

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
    : false;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, .ProseMirror')) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const editable = target.closest('[contenteditable]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

function threadDraftKeyFor(channelId: string, rootEventId: number): string {
  return `channel:${channelId}:thread:${rootEventId}`;
}

function flashEntryHandleInDocument(handle: string): void {
  requestAnimationFrame(() => {
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-entry-handle]')).find(
      (el) => el.dataset.entryHandle === handle,
    );
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('entry-flash', 'bg-accent-hover/10');
    window.setTimeout(() => target.classList.remove('entry-flash', 'bg-accent-hover/10'), 2500);
  });
}

function putTextInLastComposer(text: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message input"]');
      const el = inputs[inputs.length - 1];
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  });
}

function pathWithSearch(pathname: string, searchParams: URLSearchParams, hash = ''): string {
  const search = searchParams.toString();
  return `${pathname}${search ? `?${search}` : ''}${hash}`;
}

// View-modifier params are scoped to the surface that renders them; carrying
// them across surfaces would make e.g. a channel URL claim a lightbox file.
const GALLERY_SCOPED_PARAMS = [
  'q',
  'category',
  'channelId',
  'sessionId',
  'sort',
  'includeDeleted',
  'includeScratch',
  'starred',
  'label',
] as const;
const FILE_VIEW_PARAMS = [URL_PARAMS.file, URL_PARAMS.panel] as const;
const SESSION_VIEW_PARAMS = [
  URL_PARAMS.work,
  URL_PARAMS.view,
  URL_PARAMS.dir,
  URL_PARAMS.preview,
  URL_PARAMS.file,
  URL_PARAMS.panel,
] as const;
const MANAGED_VIEW_PARAMS: readonly string[] = [...new Set([...GALLERY_SCOPED_PARAMS, ...SESSION_VIEW_PARAMS])];

function scopedSearchForRoute(route: InAppRoute, search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  // Transient inbound deep-link params never survive an in-app navigation.
  for (const key of [URL_PARAMS.entry, URL_PARAMS.threadRoot, 'channel', 'session']) params.delete(key);
  const keep = new Set<string>(
    route.surface === 'files'
      ? [...GALLERY_SCOPED_PARAMS, ...FILE_VIEW_PARAMS]
      : route.surface === 'chat' && route.sessionId
        ? SESSION_VIEW_PARAMS
        : [],
  );
  for (const key of MANAGED_VIEW_PARAMS) {
    if (!keep.has(key)) params.delete(key);
  }
  return params;
}

function routePathWithSearch(route: InAppRoute, search: string, hash = ''): string {
  return pathWithSearch(routePath(route), scopedSearchForRoute(route, search), hash);
}

export function Chat({
  me,
  workspace,
  initialSessionId,
  initialChannelId,
  initialMainSurface,
  initialSessionFocus,
  initialEntryHandle,
  initialThreadRootEventId,
  onLogout,
}: {
  me: UserRef;
  workspace: Workspace;
  /** From the /s/:id permalink route — open this session's pane on load. */
  initialSessionId?: string | null;
  /** From /e/:handle event/artifact links or /c/:id routes — select this channel on load. */
  initialChannelId?: string | null;
  /** From /files and /activity deep links — select the main surface on load. */
  initialMainSurface?: MainSurface;
  /** Legacy /s/:id permalinks land focused; channel/session routes land split. */
  initialSessionFocus?: boolean;
  /** Entry handle from ?entry=... for one-shot scroll/highlight handling. */
  initialEntryHandle?: string | null;
  /** Thread root from /e/:handle reply links. Usually read from the rewritten URL. */
  initialThreadRootEventId?: number | null;
  onLogout: () => void;
}) {
  const { prefs } = useTheme();
  // Seed the active channel from the deep-link URL at construction so an async
  // `channels-loaded` (WS sync or a stale/empty local cache snapshot) can't win
  // the race and lock in the default `general` channel before the URL is applied.
  // The reducer's `channels-loaded` only defaults when activeChannelId is null,
  // so seeding here makes a /c/<id> deep-link deterministic.
  const [state, dispatch] = useReducer(appReducer, initialChannelId, (channelId) =>
    channelId ? { ...initialAppState, activeChannelId: channelId } : initialAppState,
  );
  const [sessionEventSeq, setSessionEventSeq] = useState(0);
  // === true-counts additions ===
  const [activityCounts, setActivityCounts] = useState<ActivityCounts>({
    attention: 0,
    unread: 0,
    needsYou: 0,
    running: 0,
    toReview: 0,
  });
  const [activityChannelCounts, setActivityChannelCounts] = useState<Record<string, ActivityChannelCounts>>({});
  const [activityLiveEvent, setActivityLiveEvent] = useState<WireEvent | null>(null);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const { clearFailedCancel, clearFailedSteer, failedCancels, failedSteers, rememberRejectedSessionOp } =
    useSessionQueueFailures();
  const calls = useCall(me, state.channels);
  const callsAvailable = useCallsAvailable();
  const stateRef = useRef(state);
  stateRef.current = state;
  const activityRefreshTimerRef = useRef<number | null>(null);
  const readCursorCacheWriteRef = useRef<Promise<void>>(Promise.resolve());
  const authInvalidatedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [queueNudgeSeq, setQueueNudgeSeq] = useState(0);
  const [unreadDividerAfterId, setUnreadDividerAfterId] = useState<number | null>(null);
  // The channel whose divider decision is frozen. `dividerReady` is derived from
  // this per-channel id (not a bare boolean) so a stale `true` from the previous
  // channel can't leak into a freshly-opened one and cause a premature landing.
  const [dividerReadyChannelId, setDividerReadyChannelId] = useState<string | null>(null);
  const dividerFrozenForRef = useRef<string | null>(null);
  const locationState = useLocation();

  // === true-counts additions ===
  const handleActivityCountsChange = useCallback(
    (next: ActivityCounts, channelCounts?: Record<string, ActivityChannelCounts>) => {
      setActivityCounts(next);
      if (channelCounts) setActivityChannelCounts(channelCounts);
    },
    [],
  );

  const refreshActivityCounts = useCallback(() => {
    // Promise.resolve() guard: a transport that throws synchronously (e.g. a
    // test environment without fetch) must not take the whole tree down; the
    // normalization guards a deploy-skewed server that predates `counts`.
    void Promise.resolve()
      .then(() => api.getActivity())
      .then(({ counts, channelCounts }) => {
        setActivityCounts({
          attention: Number(counts?.attention) || 0,
          unread: Number(counts?.unread) || 0,
          needsYou: Number(counts?.needsYou) || 0,
          running: Number(counts?.running) || 0,
          toReview: Number(counts?.toReview) || 0,
        });
        setActivityChannelCounts(channelCounts);
      })
      .catch(() => {});
  }, []);

  const scheduleActivityCountsRefresh = useCallback(() => {
    if (activityRefreshTimerRef.current != null) return;
    activityRefreshTimerRef.current = window.setTimeout(() => {
      activityRefreshTimerRef.current = null;
      refreshActivityCounts();
    }, 150);
  }, [refreshActivityCounts]);

  useEffect(() => {
    refreshActivityCounts();
    return () => {
      if (activityRefreshTimerRef.current != null) window.clearTimeout(activityRefreshTimerRef.current);
    };
  }, [refreshActivityCounts]);

  const selectChannel = useCallback((channelId: string) => {
    // Leaving a channel: read is now only marked at the bottom, so a channel
    // opened but not read to the end still has a stale cursor. `select-channel`
    // optimistically cleared its badge on open, so re-derive the outgoing
    // channel's unread from the durable cold counters before switching — else
    // it wrongly looks read until the next full channels-loaded. Re-deriving
    // while it is still the active channel keeps the incoming channel (set
    // read by the select-channel below) correct.
    const prev = stateRef.current.activeChannelId;
    if (prev && prev !== channelId) {
      dispatch({ type: 'channels-loaded', channels: stateRef.current.channels });
    }
    dispatch({ type: 'select-channel', channelId });
  }, []);

  const cacheMute = useCallback((channelId: string, muted: boolean) => {
    const channels = stateRef.current.channels.map((c) => (c.id === channelId ? { ...c, muted } : c));
    void eventCache.saveChannels(channels).catch((err: unknown) => {
      console.warn('failed to cache mute change', err);
    });
  }, []);

  const cacheSyncCursor = useCallback((cursor: number) => {
    void eventCache.saveSyncCursor(cursor).catch((err: unknown) => {
      console.warn('failed to cache sync cursor', err);
    });
  }, []);

  const cacheReadCursorAdvance = useCallback((channelId: string, lastReadEventId: number) => {
    const { channels, advanced } = channelsWithAdvancedReadCursor(
      stateRef.current.channels,
      channelId,
      lastReadEventId,
    );
    if (!advanced) return;
    readCursorCacheWriteRef.current = readCursorCacheWriteRef.current
      .catch(() => {})
      .then(() => eventCache.saveChannels(channels))
      .catch((err: unknown) => {
        console.warn('failed to cache read cursor advance', err);
      });
  }, []);

  const invalidateAuth = useCallback(() => {
    if (authInvalidatedRef.current) return;
    authInvalidatedRef.current = true;
    void clearCache().finally(onLogout);
  }, [onLogout]);

  const markQueueNudged = useCallback(() => {
    setQueueNudgeSeq((n) => n + 1);
  }, []);
  const [filesEventSeq, setFilesEventSeq] = useState(0);
  const [markupSource, setMarkupSource] = useState<MarkupPaneSource | null>(null);
  const [markupMode, setMarkupMode] = useState<MarkupPaneMode | null>(null);

  const handleFilesChangedEvent = useCallback(
    (event: WireEvent) => {
      if (event.type !== FILES_CHANGED_EVENT_TYPE) return false;
      if (filesChangedWorkspaceId(event) === workspace.id) {
        setFilesEventSeq((n) => n + 1);
      }
      return true;
    },
    [workspace.id],
  );

  const onApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) invalidateAuth();
    },
    [invalidateAuth],
  );

  const queueDispatch = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      if (action.type === 'server-event' && handleFilesChangedEvent(action.event)) return;
      dispatch(action);
      if (action.type === 'server-event') {
        if (action.event.type.startsWith('session.')) setSessionEventSeq((n) => n + 1);
        if (action.event.channelId) eventCache.enqueueEvents(action.event.channelId, [action.event]);
        cacheSyncCursor(action.event.id);
      }
      if (action.type === 'sync-cursor') cacheSyncCursor(action.cursor);
      if (action.type === 'mute-changed') cacheMute(action.channelId, action.muted);
      if (action.type === 'read-cursor') cacheReadCursorAdvance(action.channelId, action.lastReadEventId);
    },
    [cacheMute, cacheReadCursorAdvance, cacheSyncCursor, handleFilesChangedEvent],
  );

  const opRegistry = useMemo(() => createChatOpRegistry(), []);

  const opQueue = useMemo(
    () =>
      new DurableOpQueue({
        storage: eventCache,
        api,
        registry: opRegistry,
        dispatch: queueDispatch,
        lockProvider: createQueueLockProvider(),
        onRejected: (op, err) => {
          onApiError(err);
          if (op.opType === 'mute.set') {
            const payload = op.payload as { channelId?: unknown; previousMuted?: unknown };
            if (typeof payload.channelId === 'string' && typeof payload.previousMuted === 'boolean') {
              cacheMute(payload.channelId, payload.previousMuted);
            }
          }
          if (op.opType === 'prefs.set') {
            void api
              .me()
              .then(({ prefs }) => adoptPrefs(prefs))
              .catch(onApiError);
          }
          rememberRejectedSessionOp(op);
          if (!(err instanceof ApiError && err.status === 401)) {
            showErrorToast(queuedFailureMessage(op.opType, err));
          }
        },
      }),
    [cacheMute, onApiError, opRegistry, queueDispatch, rememberRejectedSessionOp],
  );

  const enqueueOp = useCallback(
    async <T extends OpType>(input: EnqueueOpInput<T>, options?: EnqueueOpOptions) => {
      const op = await opQueue.enqueue(input);
      if (op) {
        options?.onStored?.();
        opQueue.nudge();
        markQueueNudged();
        broadcastQueueNudge();
      }
      return op;
    },
    [markQueueNudged, opQueue],
  );

  const dispatchWithReadCache = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      dispatch(action);
      if (action.type === 'read-cursor') cacheReadCursorAdvance(action.channelId, action.lastReadEventId);
    },
    [cacheReadCursorAdvance],
  );

  const {
    markRead,
    noteReadCursor,
    flush: flushReadMarks,
    flushBeacon: flushReadMarksBeacon,
  } = useReadMarks({
    dispatch: dispatchWithReadCache,
    enqueueOp,
    onApiError,
  });

  const { answerSessionQuestion, cancelSession, setSessionArchived, setSessionPinned, steerSession, stopTurn } =
    useSessionActions({
      clearFailedCancel,
      clearFailedSteer,
      dispatch,
      enqueueOp,
      me,
    });

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === QUEUE_NUDGE_KEY) {
        opQueue.nudge();
        markQueueNudged();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [markQueueNudged, opQueue]);

  const queueSync = useQueueSyncState(eventCache, state.wsStatus, queueNudgeSeq);

  useEffect(() => {
    const flushCache = () => {
      flushReadMarks();
      flushReadMarksBeacon();
      void readCursorCacheWriteRef.current
        .then(() => eventCache.flushAll())
        .catch((err: unknown) => {
          console.warn('failed to flush event cache on hide', err);
        });
    };
    const flushHiddenCache = () => {
      if (document.visibilityState !== 'hidden') return;
      flushCache();
    };
    document.addEventListener('visibilitychange', flushHiddenCache);
    window.addEventListener('pagehide', flushCache);
    return () => {
      document.removeEventListener('visibilitychange', flushHiddenCache);
      window.removeEventListener('pagehide', flushCache);
    };
  }, [flushReadMarks, flushReadMarksBeacon]);

  const { queueUpload } = useUploadQueue({ enqueueOp, storage: eventCache });

  const applyQueuedOp = useCallback(
    (op: Parameters<typeof queuedOverlayAction>[0]) => {
      const overlay = queuedOverlayAction(op, me);
      if (!overlay) return;
      if (overlay.readCursor) {
        noteReadCursor(overlay.readCursor.channelId, overlay.readCursor.lastReadEventId);
      }
      dispatchWithReadCache(overlay.action);
    },
    [dispatchWithReadCache, me, noteReadCursor],
  );

  // ---- initial data ----
  useEffect(() => {
    dispatch({ type: 'init-me', handle: me.handle, id: me.id });
  }, [me.handle, me.id]);

  useEffect(() => {
    let disposed = false;
    eventCache
      .loadSnapshot()
      .then(async ({ channels, timelines, syncCursor }) => {
        if (disposed) return;
        if (channels) dispatch({ type: 'channels-loaded', channels });
        await hydrateCachedTimelines({
          timelines,
          syncCursor,
          dispatch,
          fetchLatest: (channelId) => api.messages(channelId, { limit: PAGE_SIZE }),
          fetchDelta: (channelId, afterId) => api.messages(channelId, { afterId, limit: PAGE_SIZE, folded: true }),
          isDisposed: () => disposed,
          onRepaired: (channelId, latest) => {
            void eventCache.saveTimeline(channelId, latest.events, latest.hasMore).catch((err: unknown) => {
              console.warn('failed to cache repaired hydrate history', err);
            });
          },
          onRepairFailed: (_channelId, err) => {
            console.warn('failed to repair stale cached history', err);
            onApiError(err);
          },
          onDeltaLoaded: (channelId, delta) => {
            eventCache.enqueueEvents(channelId, delta.events);
          },
          onDeltaFailed: (_channelId, err) => {
            console.warn('failed to fetch warm hydrate history delta', err);
            onApiError(err);
          },
        });
        if (disposed) return;
        if (syncCursor > 0) dispatch({ type: 'sync-cursor', cursor: syncCursor });
        await opQueue.recoverInflight();
        const queued = await eventCache.listOps();
        if (disposed) return;
        for (const op of queued) applyQueuedOp(op);
      })
      .catch((err: unknown) => {
        console.warn('failed to hydrate IndexedDB cache', err);
      })
      .finally(() => {
        if (!disposed) setHydrated(true);
      });
    return () => {
      disposed = true;
    };
  }, [applyQueuedOp, onApiError, opQueue]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(isMobileViewportNow);
  const [mainSurface, setMainSurface] = useState<MainSurface>(initialMainSurface ?? 'chat');
  const mainSurfaceRef = useRef(mainSurface);
  mainSurfaceRef.current = mainSurface;
  const legacyFocusedSessionIdRef = useRef<string | null>(
    initialSessionFocus && initialSessionId ? initialSessionId : null,
  );
  const initialPropRouteAppliedRef = useRef(false);
  const [channelMemberCache, setChannelMemberCache] = useState<Record<string, UserRef[]>>({});
  const channelMemberRequestsRef = useRef<Set<string>>(new Set());
  const [createChannelRequestSeq, setCreateChannelRequestSeq] = useState(0);
  const [startDmRequestSeq, setStartDmRequestSeq] = useState(0);
  // Configured-spawn dialog (the summon sigil is the quick path).
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnInitialTask, setSpawnInitialTask] = useState('');
  const [configureRestore, setConfigureRestore] = useState<{ draftKey: string; text: string } | null>(null);
  const channelComposerRef = useRef<ComposerHandle>(null);
  const [demoStarting, setDemoStarting] = useState(false);
  const agentProfiles = useAgentProfiles();
  const {
    available: connectionsAvailable,
    connectGitHub,
    activateGitHubIdentity,
    connectionDialog,
    disconnectGitHub,
    githubConnection,
    setConnectionDialog,
  } = useConnections();
  const {
    disconnectClaude,
    disconnectCodex,
    openProviderConnect,
    providerCredentials,
    providerDialog,
    saveClaudeToken,
    saveCodexAuthJson,
    setProviderDialog,
  } = useProviderCredentials();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const sync = () => setIsMobileViewport(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // ---- heal stale session entities ----
  // Cards folded from history only move via live WS events; a session whose
  // terminal event predates our page never updates. Refetch each non-terminal
  // session once so dead "starting/running" chips converge on server truth.
  const reconciledRef = useRef(new Set<string>());
  useEffect(() => {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (isPendingSessionId(id) || isTerminalSessionStatus(session.status)) continue;
      if (reconciledRef.current.has(id)) continue;
      reconciledRef.current.add(id);
      sessionsApi
        .get(id)
        .then(({ session: wire }) => dispatch({ type: 'session-upsert', session: sessionFromWire(wire) }))
        .catch(() => {}); // unreachable server — the stalled display covers it
    }
  }, [state.sessions]);

  // Live sessions blocked on a person pin into Attention immediately, before
  // (or without) the server feed item — parity with the mobile Attention tab.
  const liveAttentionItems = useMemo(() => {
    const items: ActivityItem[] = [];
    for (const session of Object.values(state.sessions)) {
      if (isPendingSessionId(session.id)) continue;
      const kind = sessionAttentionKind(session);
      if (!kind || kind === 'failed') continue;
      const channel = state.channels.find((c) => c.id === session.channelId);
      items.push({
        eventId: `live:${session.id}`,
        kind: kind === 'authentication' ? 'agent_auth' : kind === 'seat-request' ? 'seat_request' : 'agent_question',
        channelId: session.channelId,
        channelName: channel?.name ?? '',
        actorId: null,
        actorName: null,
        snippet: session.pendingQuestion?.questions[0]?.question ?? session.providerAuthRequired?.message ?? '',
        createdAt: session.pendingQuestion?.askedAt ?? session.createdAt,
        sessionId: session.id,
        sessionTitle: session.title,
        sessionStatus: session.status,
        attention: true,
        unread: true,
      });
    }
    return items;
  }, [state.sessions, state.channels]);

  const active = state.channels.find((c) => c.id === state.activeChannelId) ?? null;
  const timeline = (active && state.timelines[active.id]) || emptyTimeline;
  const openThreadRoot =
    state.openThreadRootId != null ? (timeline.main.find((m) => m.id === state.openThreadRootId) ?? null) : null;
  const threadReplies = state.openThreadRootId != null ? (timeline.threads[state.openThreadRootId] ?? []) : [];
  const threadLoaded = state.openThreadRootId != null && timeline.threads[state.openThreadRootId] !== undefined;
  const activeDraftKey = active ? `channel:${active.id}` : '';
  const threadDraftKey = active && openThreadRoot?.id != null ? `channel:${active.id}:thread:${openThreadRoot.id}` : '';
  const activeChannelId = active?.id ?? null;

  useEffect(() => {
    const cid = state.activeChannelId;
    if (!cid) {
      setUnreadDividerAfterId(null);
      setDividerReadyChannelId(null);
      dividerFrozenForRef.current = null;
      return;
    }
    const channel = state.channels.find((c) => c.id === cid);
    const timeline = state.timelines[cid];
    const lastRead = channel?.lastReadEventId ?? 0;
    const counter = channel?.latestEventId ?? 0;
    const loadedNewest = timeline?.lastEventId ?? 0;
    const newestRendered = newestConfirmedMainEventId(timeline);
    // A cold-counter repair (see the messages() effect that refetches when the server
    // counter is ahead of the loaded tail) is in flight while counter > loadedNewest.
    // Until it lands we cannot tell a real gap from a stale counter, so we must NOT
    // freeze the divider yet — freezing now would lock in a wrong decision.
    const repairPending = timeline?.loaded === true && counter > loadedNewest;

    if (dividerFrozenForRef.current === cid) {
      // Frozen so the divider doesn't move as YOU read here. If another device/tab
      // caught this channel up, dissolve the now-phantom divider. Marker only; never scroll.
      if ((state.remoteReadCursors[cid] ?? 0) >= newestRendered && newestRendered > 0) {
        setUnreadDividerAfterId((prev) => (prev == null ? prev : null));
      }
      return;
    }

    // Divider ONLY when a genuinely LOADED event sits beyond the read cursor. A server
    // counter that's merely ahead (nothing loaded past the cursor) is a phantom → no
    // divider → land at bottom. The repair fetch re-runs this effect with the real tail.
    setUnreadDividerAfterId(lastRead > 0 && loadedNewest > lastRead ? lastRead : null);

    // Freeze only once the loaded tail is caught up to the counter (no repair pending);
    // otherwise wait so a real gap still shows the divider once the tail is fetched.
    if (timeline?.loaded === true && !repairPending) {
      dividerFrozenForRef.current = cid;
      setDividerReadyChannelId(cid);
    }
  }, [state.activeChannelId, state.channels, state.timelines, state.remoteReadCursors]);

  // Ready only when the frozen decision belongs to the currently active channel.
  const dividerReady = dividerReadyChannelId != null && dividerReadyChannelId === state.activeChannelId;

  useEffect(() => {
    if (!activeChannelId) return;
    const channelId = activeChannelId;
    if (channelMemberRequestsRef.current.has(channelId)) return;
    channelMemberRequestsRef.current.add(channelId);
    api
      .channelMembers(channelId)
      .then(({ members }) => {
        setChannelMemberCache((current) => ({ ...current, [channelId]: members }));
      })
      .catch((err: unknown) => {
        onApiError(err);
        setChannelMemberCache((current) => (current[channelId] ? current : { ...current, [channelId]: [] }));
      });
  }, [activeChannelId, onApiError]);
  const activeUserMap = useMemo(() => {
    const users = new Map<string, UserRef>();
    const remember = (user: UserRef | null | undefined) => {
      if (user) users.set(user.id, user);
    };
    if (active) {
      active.members?.forEach(remember);
      channelMemberCache[active.id]?.forEach(remember);
    }
    for (const message of timeline.main) remember(message.author);
    for (const replies of Object.values(timeline.threads)) {
      for (const message of replies) remember(message.author);
    }
    remember(me);
    return users;
  }, [active, channelMemberCache, me, timeline.main, timeline.threads]);
  const resolveActiveUser = useCallback((id: string) => activeUserMap.get(id), [activeUserMap]);
  const activeDraftKeysForSync = useMemo((): ReadonlySet<string> => {
    const keys = new Set<string>();
    if (state.activeChannelId) {
      keys.add(`channel:${state.activeChannelId}`);
      if (state.openThreadRootId != null) {
        keys.add(`channel:${state.activeChannelId}:thread:${state.openThreadRootId}`);
      }
    }
    return keys;
  }, [state.activeChannelId, state.openThreadRootId]);
  const {
    drafts,
    draftAgentIntents,
    enqueueDraft,
    markDraftTouched,
    putTextInComposer,
    reconcileDraftsFromSnapshot,
    saveDraft,
  } = useDraftState({
    activeDraftKeysForSync,
    activeDraftKey,
    enqueueOp,
    threadDraftKey,
  });

  // ---- websocket ----
  // Channels for fanout + a `session:<id>` presence key while spectating a pane.
  const wsKeys = useMemo(() => {
    const keys = state.channels.map((c) => c.id);
    if (state.openSessionId && !isPendingSessionId(state.openSessionId)) {
      keys.push(`session:${state.openSessionId}`);
    }
    return keys;
  }, [state.channels, state.openSessionId]);

  const flushQueuedOps = useCallback(() => {
    // Reconnect-triggered: clears per-op backoff so queued work retries now.
    opQueue.reconnect();
  }, [opQueue]);

  const resetLoadedTimelinesToLatest = useCallback(async () => {
    const loaded = Object.entries(stateRef.current.timelines).filter(([, t]) => t.loaded);
    await Promise.all(
      loaded.map(async ([channelId]) => {
        const latest = await api.messages(channelId, { limit: PAGE_SIZE });
        dispatch({
          type: 'history-reset',
          channelId,
          events: latest.events,
          hasMore: latest.hasMore,
          readCursor: latest.readCursor,
        });
        void eventCache.saveTimeline(channelId, latest.events, latest.hasMore).catch((err: unknown) => {
          console.warn('failed to cache sync repair history', err);
        });
      }),
    );
  }, []);

  const syncFromCursor = useCallback(async () => {
    let cursor = stateRef.current.syncCursor;
    for (;;) {
      const catchupCursor = cursor;
      const response = await api.sync(catchupCursor, { limit: SYNC_LIMIT, folded: true });
      if (response.limited) {
        dispatchSyncSnapshot(dispatch, response.state, adoptPrefs);
        reconcileDraftsFromSnapshot(response.state.drafts ?? {}, response.state.draftDeletions ?? {});
        void eventCache.saveChannels(response.state.channels).catch((err: unknown) => {
          console.warn('failed to cache sync channels', err);
        });
        await resetLoadedTimelinesToLatest();
        dispatch({ type: 'sync-cursor', cursor: response.nextCursor });
        cacheSyncCursor(response.nextCursor);
        return;
      }
      dispatchSyncResponse(dispatch, response, {
        onPrefs: adoptPrefs,
        catchupCursor,
        onEvent: (event) => {
          if (event.type.startsWith('session.')) setSessionEventSeq((n) => n + 1);
          if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
          cacheSyncCursor(event.id);
        },
      });
      reconcileDraftsFromSnapshot(response.state.drafts ?? {}, response.state.draftDeletions ?? {});
      void eventCache.saveChannels(response.state.channels).catch((err: unknown) => {
        console.warn('failed to cache sync channels', err);
      });
      cacheSyncCursor(response.nextCursor);
      cursor = Math.max(cursor, response.nextCursor);
      if (response.events.length < SYNC_LIMIT) return;
    }
  }, [cacheSyncCursor, reconcileDraftsFromSnapshot, resetLoadedTimelinesToLatest]);

  const syncInFlightRef = useRef<Promise<void> | null>(null);
  const runReconnectSync = useCallback(() => {
    if (!syncInFlightRef.current) {
      const work = syncFromCursor().finally(() => {
        syncInFlightRef.current = null;
      });
      syncInFlightRef.current = work;
    }
    return syncInFlightRef.current;
  }, [syncFromCursor]);

  const syncThenFlushQueuedOps = useCallback(() => {
    void runReconnectSync()
      .then(() => calls.refreshActiveCalls())
      .then(flushQueuedOps)
      .catch(onApiError);
  }, [calls.refreshActiveCalls, flushQueuedOps, onApiError, runReconnectSync]);

  useEffect(() => {
    if (hydrated) syncThenFlushQueuedOps();
  }, [hydrated, syncThenFlushQueuedOps]);

  const { clearTypingUser, onSessionTyping, onTyping, sessionTyping, typing } = useTypingIndicators({
    activeChannelId: state.activeChannelId,
    meId: me.id,
  });

  const ws = useWs(
    hydrated,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
        if (handleFilesChangedEvent(event)) return;
        if (event.type.startsWith('session.')) setSessionEventSeq((n) => n + 1);
        if (isActivityRefreshEvent(event, me, stateRef.current.channels, stateRef.current.sessions)) {
          setActivityLiveEvent(event);
          scheduleActivityCountsRefresh();
        }
        // A message landing ends that author's "is typing…" immediately.
        if (event.type === 'message.posted' && event.actorId) {
          clearTypingUser(event.actorId);
        }
        maybeNotify(event);
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
        cacheSyncCursor(event.id);
      },
      onPresence: (channelId, users) => dispatch({ type: 'presence', channelId, users }),
      onTyping,
      onSessionTyping,
      onCall: calls.handleCallEvent,
      onRead: (channelId, lastReadEventId) => {
        noteReadCursor(channelId, lastReadEventId);
        dispatchWithReadCache({ type: 'read-cursor', channelId, lastReadEventId, source: 'remote' });
      },
      onMuted: (channelId, muted) => {
        dispatch({ type: 'mute-changed', channelId, muted });
        cacheMute(channelId, muted);
      },
      onChannelPinned: (channelId, pinned) => dispatch({ type: 'channel-pin-changed', channelId, pinned }),
      onSessionPinned: (sessionId, pinned) => dispatch({ type: 'session-pin-changed', sessionId, pinned }),
      onSessionActivity: (sessionId, activity) =>
        dispatch({ type: 'session-activity', sessionId, summary: activity.summary, at: activity.at }),
      onChannelLeft: (channelId) => dispatch({ type: 'channel-removed', channelId }),
      onPrefs: adoptPrefs,
      onOpen: () => {
        syncThenFlushQueuedOps();
        setActivityRefreshKey((n) => n + 1);
        scheduleActivityCountsRefresh();
      },
      onStatus: (status) => {
        dispatch({ type: 'ws-status', status });
        if (wsStatusKind(status) === 'auth-failed') invalidateAuth();
      },
    },
    state.activeChannelId,
    // Desktop shell: connect to the absolute server origin with a bearer token
    // in the query string. E2E may pass a direct browser WS URL to avoid the
    // Vite proxy; normal browsers keep same-origin /ws.
    isDesktop ? { url: () => desktopWsUrl() ?? '' } : browserWsUrl ? { url: browserWsUrl } : undefined,
  );

  const lastTypingSentRef = useRef(0);
  const notifyTyping = (channelId: string) => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2500) return;
    lastTypingSentRef.current = now;
    ws.sendTyping(channelId);
  };
  const lastSessionTypingSentRef = useRef<Record<string, number>>({});
  const notifySessionTyping = (sessionId: string) => {
    const now = Date.now();
    if (now - (lastSessionTypingSentRef.current[sessionId] ?? 0) < 2500) return;
    lastSessionTypingSentRef.current[sessionId] = now;
    ws.sendSessionTyping(sessionId);
  };

  // Desktop notifications: mentions of me, and my agent sessions finishing.
  // Live WS events only (catch-up misses land in badges instead).
  function maybeNotify(event: WireEvent) {
    const notification = notificationForWireEvent(
      event,
      me,
      stateRef.current.channels,
      stateRef.current.sessions,
      prefs.notifications,
    );
    if (!notification) return;
    if (notification.kind === 'message') {
      showNotification(notification.title, notification.body, notification.tag, () => {
        if (notification.channelId) {
          navigate(
            routePathWithSearch(
              { surface: 'chat', channelId: notification.channelId, sessionId: null, focusSession: false },
              locationState.search,
              locationState.hash,
            ),
          );
        }
      });
      return;
    }
    showNotification(notification.title, notification.body, notification.tag, () => {
      const channelId = stateRef.current.sessions[notification.sessionId]?.channelId ?? null;
      navigate(
        routePathWithSearch(
          { surface: 'chat', channelId, sessionId: notification.sessionId, focusSession: false },
          locationState.search,
          locationState.hash,
        ),
      );
    });
  }

  // ---- channel selection & history ----
  const handleReachBottom = useCallback(() => {
    const current = stateRef.current;
    const channel = current.channels.find((c) => c.id === current.activeChannelId);
    const currentTimeline = channel ? current.timelines[channel.id] : null;
    if (channel && currentTimeline) markRead(channel.id, currentTimeline.lastEventId, { immediate: true });
  }, [markRead]);

  useEffect(() => {
    if (!active) return;
    const channelId = active.id;
    const current = state.timelines[channelId];
    const latestEventId = active.latestEventId ?? 0;
    const needsInitialLoad = current?.loaded !== true;
    const needsColdCounterRepair = current?.loaded === true && latestEventId > current.lastEventId;
    if (!needsInitialLoad && !needsColdCounterRepair) return;
    api
      .messages(channelId, { limit: PAGE_SIZE })
      .then(({ events, hasMore, readCursor }) => {
        // Skip if we lost access (kicked from a private channel) while the
        // fetch was in flight — avoids a ghost timeline.
        if (!stateRef.current.channels.some((c) => c.id === channelId)) return;
        dispatch({
          type: needsColdCounterRepair ? 'history-reset' : 'history-loaded',
          channelId,
          events,
          hasMore,
          readCursor,
        });
        void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
          console.warn('failed to cache history', err);
        });
      })
      .catch(onApiError);
  }, [active?.id, active?.latestEventId, onApiError]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadEarlier = (): Promise<void> => {
    if (!active) return Promise.resolve();
    const oldest = timeline.main.find((m) => m.status === 'confirmed');
    if (!oldest?.id) return Promise.resolve();
    const channelId = active.id;
    const expectedTimelineEpoch = stateRef.current.timelineEpochs[channelId] ?? 0;
    return api
      .messages(channelId, { beforeId: oldest.id, limit: PAGE_SIZE })
      .then(({ events, hasMore, readCursor }) => {
        if ((stateRef.current.timelineEpochs[channelId] ?? 0) !== expectedTimelineEpoch) return;
        dispatch({ type: 'history-loaded', channelId, events, hasMore, expectedTimelineEpoch, readCursor });
        void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
          console.warn('failed to cache earlier history', err);
        });
      })
      .catch(onApiError);
  };

  const ensureTopLevelEventLoaded = useCallback(async (channelId: string, eventId: number): Promise<boolean> => {
    for (let tries = 0; tries < 30; tries++) {
      const t = stateRef.current.timelines[channelId];
      if (t?.main.some((m) => m.id === eventId)) return true;
      if (!t?.loaded) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      if (!t.hasMoreBefore) return false;
      const oldest = t.main.find((m) => m.status === 'confirmed');
      if (!oldest?.id) return false;
      const expectedTimelineEpoch = stateRef.current.timelineEpochs[channelId] ?? 0;
      const { events, hasMore } = await api.messages(channelId, {
        beforeId: oldest.id,
        limit: PAGE_SIZE,
      });
      if ((stateRef.current.timelineEpochs[channelId] ?? 0) !== expectedTimelineEpoch) continue;
      dispatch({ type: 'history-loaded', channelId, events, hasMore, expectedTimelineEpoch });
      void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
        console.warn('failed to cache thread root history', err);
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    return stateRef.current.timelines[channelId]?.main.some((m) => m.id === eventId) === true;
  }, []);

  const openThreadInChannel = useCallback(
    async (channelId: string, rootEventId: number): Promise<boolean> => {
      const hasRoot = await ensureTopLevelEventLoaded(channelId, rootEventId);
      if (!hasRoot) return false;
      const current = stateRef.current;
      const root = current.timelines[channelId]?.main.find((message) => message.id === rootEventId);
      const attachedSessionId =
        root?.sessionId ??
        Object.values(current.sessions).find((session) => session.threadRootEventId === rootEventId)?.id ??
        null;
      if (current.openSessionId && current.openSessionId !== attachedSessionId) {
        dispatch({ type: 'close-session' });
      }
      dispatch({ type: 'open-thread', rootEventId });
      const { events } = await api.thread(rootEventId);
      dispatch({ type: 'thread-loaded', channelId, rootEventId, events });
      return true;
    },
    [ensureTopLevelEventLoaded],
  );

  // ---- thread panel ----
  const openThread = useCallback(
    (rootEventId: number) => {
      if (!active) return;
      navigate(
        routePathWithSearch(
          {
            surface: 'chat',
            channelId: active.id,
            sessionId: null,
            threadRootId: String(rootEventId),
            focusSession: false,
          },
          locationState.search,
          locationState.hash,
        ),
      );
    },
    [active, locationState.hash, locationState.search],
  );

  // === web-client additions ===
  const openNotificationTarget = useCallback(
    (target: NotificationClickTarget, options?: { replace?: boolean }) => {
      const threadRootEventId = notificationThreadRootId(target.threadRootId);
      const channelId = target.channelId ?? null;
      if (!channelId && !target.sessionId) return;
      navigate(
        routePathWithSearch(
          {
            surface: 'chat',
            channelId,
            sessionId: threadRootEventId == null ? (target.sessionId ?? null) : null,
            threadRootId: channelId && threadRootEventId != null ? String(threadRootEventId) : null,
            focusSession: false,
          },
          locationState.search,
          locationState.hash,
        ),
        options,
      );
    },
    [locationState.hash, locationState.search],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const channelId = params.get('channel') ?? undefined;
    const sessionId = params.get('session') ?? undefined;
    const threadRootId = threadRootParamFromSearch(window.location.search);
    if (!channelId && !sessionId) return;
    openNotificationTarget(
      {
        ...(channelId ? { channelId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(threadRootId != null ? { threadRootId } : {}),
      },
      { replace: true },
    );
  }, [openNotificationTarget]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onNotificationClick = (event: Event) => {
      const target = notificationClickTarget((event as CustomEvent<unknown>).detail);
      if (target) openNotificationTarget(target);
    };
    window.addEventListener('atrium:notification-click', onNotificationClick);
    return () => window.removeEventListener('atrium:notification-click', onNotificationClick);
  }, [openNotificationTarget]);
  // === web-client additions ===

  useEffect(() => {
    const params = new URLSearchParams(locationState.search);
    if (params.has('channel') || params.has('session')) return;
    const threadRootId = threadRootParamFromSearch(locationState.search);
    if (threadRootId == null) return;
    const parsed = parseInAppRoute(locationState.pathname);
    const channelId = parsed?.channelId ?? stateRef.current.activeChannelId;
    if (!channelId) return;
    params.delete(URL_PARAMS.threadRoot);
    navigate(
      pathWithSearch(
        routePath({
          surface: 'chat',
          channelId,
          sessionId: null,
          threadRootId: String(threadRootId),
          focusSession: false,
        }),
        params,
        locationState.hash,
      ),
      { replace: true },
    );
  }, [locationState.hash, locationState.pathname, locationState.search, activeChannelId]);

  const openMarkupReply = useCallback(
    async (handle: string, message: { channelId: string; id: number | null; threadRootEventId: number | null }) => {
      const threadRootEventId = message.threadRootEventId ?? message.id;
      if (threadRootEventId == null) return;
      try {
        const extracted = await api.extractEntry(handle);
        const response = await fetch(`/api/files/artifact/${encodeURIComponent(extracted.artifactId)}/content`, {
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('Could not load markup source');
        const content = await response.text();
        const { frontmatter, body } = splitMarkdownFrontmatter(content);
        setMarkupSource({
          artifactId: extracted.artifactId,
          path: extracted.path,
          seq: extracted.seq,
          workspaceId: extracted.workspaceId,
          sessionId: '',
          frontmatter,
          body,
          sourceText: extracted.sourceText ?? null,
        });
        setMarkupMode({ kind: 'reply', channelId: message.channelId, threadRootEventId });
      } catch (err) {
        showErrorToast(err instanceof Error ? err.message : 'Could not open markup pane');
      }
    },
    [],
  );

  const openDiscussThread = useCallback(
    (payload: TranscriptDiscussPayload) => {
      navigate(
        routePathWithSearch(
          {
            surface: 'chat',
            channelId: payload.channelId,
            sessionId: null,
            threadRootId: String(payload.threadRootEventId),
            focusSession: false,
          },
          locationState.search,
          locationState.hash,
        ),
      );
      const draftKey = threadDraftKeyFor(payload.channelId, payload.threadRootEventId);
      markDraftTouched(draftKey);
      void saveDraft(draftKey, payload.draft);
      void openThreadInChannel(payload.channelId, payload.threadRootEventId)
        .then((opened) => {
          if (opened) putTextInLastComposer(payload.draft);
        })
        .catch(onApiError);
    },
    [locationState.hash, locationState.search, markDraftTouched, onApiError, openThreadInChannel, saveDraft],
  );

  const seedActiveChannelComposer = useCallback(
    (draft: string) => {
      navigate(
        routePathWithSearch(
          { surface: 'chat', channelId: stateRef.current.activeChannelId, sessionId: null, focusSession: false },
          locationState.search,
          locationState.hash,
        ),
      );
      dispatch({ type: 'close-thread' });
      putTextInComposer(draft);
    },
    [locationState.hash, locationState.search, putTextInComposer],
  );

  const openSpawnWithInitialTask = useCallback((task: string) => {
    setSpawnInitialTask(task);
    setSpawnOpen(true);
  }, []);

  const cancelSpawnDialog = useCallback(() => {
    setSpawnOpen(false);
    setSpawnInitialTask('');
    if (!configureRestore) return;
    if (configureRestore.draftKey === activeDraftKey && channelComposerRef.current) {
      channelComposerRef.current.restoreDraft(configureRestore.text);
    } else {
      markDraftTouched(configureRestore.draftKey);
      void saveDraft(configureRestore.draftKey, configureRestore.text);
    }
    setConfigureRestore(null);
  }, [activeDraftKey, configureRestore, markDraftTouched, saveDraft]);
  const sessionFocusFromUrl = useMemo(
    () => new URLSearchParams(locationState.search).get(URL_PARAMS.view) === 'focus',
    [locationState.search],
  );

  const {
    focused,
    paneSession,
    paneWatchers,
    sessionPaneLayout,
    setFocused,
    setView: setPaneView,
    spectators,
    toggleFocus: togglePaneFocus,
    view,
  } = useSessionPaneState({
    activeChannel: active,
    dispatch,
    focusedFromUrl: sessionFocusFromUrl,
    isMobileViewport,
    openSessionId: state.openSessionId,
    presence: state.presence,
    sessions: state.sessions,
  });
  const paneOptimisticThreadSteers = useMemo(() => {
    const root = paneSession?.threadRootEventId;
    if (!paneSession || root == null) return [];
    return (state.timelines[paneSession.channelId]?.threads[root] ?? []).filter(
      (message) => message.steeredSessionId === paneSession.id && message.status !== 'confirmed',
    );
  }, [paneSession, state.timelines]);

  const defaultChannelId = useCallback((): string | null => {
    const channels = stateRef.current.channels;
    return channels.find((c) => c.name === 'general')?.id ?? channels[0]?.id ?? null;
  }, []);

  const applyInAppRoute = useCallback(
    (route: InAppRoute) => {
      const current = stateRef.current;
      if (route.surface !== 'chat') {
        if (route.channelId && current.activeChannelId !== route.channelId) selectChannel(route.channelId);
        legacyFocusedSessionIdRef.current = null;
        if (current.openSessionId) dispatch({ type: 'close-session' });
        if (current.openThreadRootId != null) dispatch({ type: 'close-thread' });
        if (mainSurfaceRef.current !== route.surface) setMainSurface(route.surface);
        return;
      }

      if (mainSurfaceRef.current !== 'chat') setMainSurface('chat');
      const nextChannelId = route.channelId ?? defaultChannelId();
      if (nextChannelId && current.activeChannelId !== nextChannelId) selectChannel(nextChannelId);

      if (route.threadRootId) {
        legacyFocusedSessionIdRef.current = null;
        setFocused(false);
        const rootEventId = Number(route.threadRootId);
        if (nextChannelId && Number.isSafeInteger(rootEventId)) {
          void openThreadInChannel(nextChannelId, rootEventId).catch(onApiError);
        }
        return;
      }

      if (route.membersOpen) {
        legacyFocusedSessionIdRef.current = null;
        if (current.openSessionId) dispatch({ type: 'close-session' });
        if (current.openThreadRootId != null) dispatch({ type: 'close-thread' });
        setFocused(false);
        return;
      }

      if (!route.sessionId) {
        legacyFocusedSessionIdRef.current = null;
        if (current.openSessionId) dispatch({ type: 'close-session' });
        if (current.openThreadRootId != null) dispatch({ type: 'close-thread' });
        setFocused(false);
        return;
      }

      if (route.focusSession) legacyFocusedSessionIdRef.current = route.sessionId;
      const keepLegacyFocus = legacyFocusedSessionIdRef.current === route.sessionId;
      setFocused(route.focusSession || keepLegacyFocus || sessionFocusFromUrl);
      if (current.openSessionId !== route.sessionId) dispatch({ type: 'open-session', sessionId: route.sessionId });

      sessionsApi
        .get(route.sessionId)
        .then(({ session }) => {
          dispatch({ type: 'session-upsert', session: sessionFromWire(session) });
          const openRoot = stateRef.current.openThreadRootId;
          if (openRoot != null && session.threadRootEventId !== openRoot) dispatch({ type: 'close-thread' });
          const sessionChannelId = session.channelId || route.channelId || null;
          if (sessionChannelId) {
            if (stateRef.current.activeChannelId !== sessionChannelId) selectChannel(sessionChannelId);
            const canonical = routePath({
              surface: 'chat',
              channelId: sessionChannelId,
              sessionId: session.id,
              focusSession: false,
            });
            const canonicalWithSearch = `${canonical}${window.location.search}${window.location.hash}`;
            if (
              (route.focusSession || !route.channelId || route.channelId !== sessionChannelId) &&
              `${window.location.pathname}${window.location.search}${window.location.hash}` !== canonicalWithSearch
            ) {
              navigate(canonicalWithSearch, { replace: true });
            }
          }
          if (stateRef.current.openSessionId !== session.id) dispatch({ type: 'open-session', sessionId: session.id });
        })
        .catch(() => dispatch({ type: 'session-load-failed', sessionId: route.sessionId! }));
    },
    [defaultChannelId, onApiError, openThreadInChannel, selectChannel, sessionFocusFromUrl, setFocused],
  );

  useEffect(() => {
    const parsed = parseInAppRoute(locationState.pathname);
    if (parsed) applyInAppRoute(parsed);
  }, [applyInAppRoute, locationState.pathname]);

  useEffect(() => {
    if (initialPropRouteAppliedRef.current) return;
    const route: InAppRoute = {
      surface: initialMainSurface ?? 'chat',
      channelId: initialChannelId ?? null,
      sessionId: initialSessionId ?? null,
      focusSession: initialSessionFocus ?? false,
    };
    if (route.surface === 'chat' && !route.channelId && !route.sessionId && !route.focusSession) return;
    initialPropRouteAppliedRef.current = true;
    applyInAppRoute(route);
  }, [applyInAppRoute, initialChannelId, initialMainSurface, initialSessionFocus, initialSessionId]);

  const goToRoute = useCallback(
    (route: InAppRoute, options?: { replace?: boolean }) => {
      navigate(routePathWithSearch(route, locationState.search, locationState.hash), options);
    },
    [locationState.hash, locationState.search],
  );

  const goToChannel = useCallback(
    (channelId: string) => {
      goToRoute({ surface: 'chat', channelId, sessionId: null, focusSession: false });
    },
    [goToRoute],
  );

  const openSession = useCallback(
    (sessionId: string, options?: SpineOpenSessionOptions) => {
      if (isPendingSessionId(sessionId)) return;
      // === true-counts additions ===
      // Navigation must not wait on this idempotent per-session acknowledgement.
      void api
        .markSessionActivityRead(sessionId)
        .then(() => scheduleActivityCountsRefresh())
        .catch(() => {});
      const sessionChannelId = stateRef.current.sessions[sessionId]?.channelId ?? stateRef.current.activeChannelId;
      const route: InAppRoute = {
        surface: 'chat',
        channelId: sessionChannelId,
        sessionId,
        focusSession: false,
      };
      // === spine additions === The pane already consumes ?work= into its tab state.
      if (options?.workTab) {
        const params = new URLSearchParams(locationState.search);
        params.set(URL_PARAMS.work, TAB_SLUG[options.workTab]);
        navigate(routePathWithSearch(route, `?${params.toString()}`, locationState.hash));
        return;
      }
      goToRoute(route);
    },
    [goToRoute, locationState.hash, locationState.search, scheduleActivityCountsRefresh],
  );

  const closeSession = useCallback(() => {
    goToRoute({
      surface: 'chat',
      channelId: stateRef.current.activeChannelId,
      sessionId: null,
      focusSession: false,
    });
  }, [goToRoute]);

  const openFilesSurface = useCallback(() => {
    goToRoute({ surface: 'files', channelId: null, sessionId: null, focusSession: false });
  }, [goToRoute]);

  const openActivitySurface = useCallback(() => {
    goToRoute({ surface: 'activity', channelId: null, sessionId: null, focusSession: false });
  }, [goToRoute]);

  const openAgentsSurface = useCallback(() => {
    goToRoute({ surface: 'agents', channelId: null, sessionId: null, focusSession: false });
  }, [goToRoute]);

  const openSettingsSurface = useCallback(() => {
    goToRoute({ surface: 'settings', channelId: null, sessionId: null, focusSession: false });
  }, [goToRoute]);

  const openChatSurface = useCallback(() => {
    const channelId = stateRef.current.activeChannelId;
    goToRoute({
      surface: 'chat',
      channelId,
      sessionId: null,
      focusSession: false,
    });
  }, [goToRoute]);

  const writeFocusViewParam = useCallback((nextFocused: boolean) => {
    // Read the LIVE location, not the render-captured one: pinning the work
    // drawer writes ?work= and toggles focus in the same tick, and a stale
    // search here would clobber that first write.
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (nextFocused) params.set(URL_PARAMS.view, 'focus');
    else params.delete(URL_PARAMS.view);
    navigate(pathWithSearch(window.location.pathname, params, window.location.hash), { replace: true });
  }, []);

  const toggleFocus = useCallback(() => {
    writeFocusViewParam(!focused);
    togglePaneFocus();
  }, [focused, togglePaneFocus, writeFocusViewParam]);

  const setView = useCallback(
    (next: Parameters<typeof setPaneView>[0]) => {
      if (next === 'channel') closeSession();
      else {
        writeFocusViewParam(next === 'focus');
        setPaneView(next);
      }
    },
    [closeSession, setPaneView, writeFocusViewParam],
  );
  // Match SessionPane's persisted width so the pane doesn't jump when it
  // replaces the loading placeholder; read storage once per opened session,
  // not on every Chat render.
  const placeholderPaneSizing = useMemo(() => sessionPaneSizing(loadSessionPaneWidth()), [state.openSessionId]);

  const { editMessage, reactToMessage, removeMessage, retry, send, sendAgent, startConfiguredSession } =
    useChatMessageActions({
      activeChannel: active,
      dispatch,
      enqueueOp,
      me,
      onSpawnDialogClose: () => {
        setSpawnOpen(false);
        setSpawnInitialTask('');
      },
    });

  // ---- jump to a message from search: page history back until it's loaded ----
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [pendingEntryHandle, setPendingEntryHandle] = useState<string | null>(() => {
    if (initialEntryHandle) return initialEntryHandle;
    return typeof window === 'undefined' ? null : entryParamFromSearch(window.location.search);
  });
  const [pendingEntryThreadRootId, setPendingEntryThreadRootId] = useState<number | null>(() => {
    if (initialThreadRootEventId != null) return initialThreadRootEventId;
    return typeof window === 'undefined' ? null : threadRootParamFromSearch(window.location.search);
  });
  useEffect(() => {
    if (highlightId == null) return;
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId]);

  useEffect(() => {
    if (!pendingEntryHandle || pendingEntryHandle.startsWith('rec_') || pendingEntryThreadRootId != null) return;
    const eventMatch = /^evt_(\d+)$/.exec(pendingEntryHandle);
    if (!eventMatch) {
      stripEntryParamFromLocation();
      setPendingEntryHandle(null);
      return;
    }
    if (!active || !timeline.loaded) return;
    const eventId = Number(eventMatch[1]);
    if (Number.isSafeInteger(eventId) && timeline.main.some((m) => m.id === eventId)) {
      setHighlightId(eventId);
    }
    stripEntryParamFromLocation();
    setPendingEntryHandle(null);
  }, [active, pendingEntryHandle, pendingEntryThreadRootId, timeline.loaded, timeline.main]);

  useEffect(() => {
    if (!pendingEntryHandle || pendingEntryThreadRootId == null) return;
    const eventMatch = /^evt_(\d+)$/.exec(pendingEntryHandle);
    if (!eventMatch) {
      stripEntryParamFromLocation();
      setPendingEntryHandle(null);
      setPendingEntryThreadRootId(null);
      return;
    }
    if (!active) return;
    let disposed = false;
    void openThreadInChannel(active.id, pendingEntryThreadRootId)
      .then((opened) => {
        if (disposed) return;
        if (opened) flashEntryHandleInDocument(pendingEntryHandle);
        stripEntryParamFromLocation();
        setPendingEntryHandle(null);
        setPendingEntryThreadRootId(null);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setPendingEntryHandle(null);
        setPendingEntryThreadRootId(null);
        onApiError(err);
      });
    return () => {
      disposed = true;
    };
  }, [active, onApiError, openThreadInChannel, pendingEntryHandle, pendingEntryThreadRootId]);

  const jumpToMessage = async (event: WireEvent) => {
    const channelId = event.channelId;
    if (!channelId) return;
    goToChannel(channelId);
    for (let tries = 0; tries < 30; tries++) {
      const t = stateRef.current.timelines[channelId];
      if (t?.main.some((m) => m.id === event.id)) break;
      if (!t?.loaded) {
        // Initial history fetch for this channel is still in flight.
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      if (!t.hasMoreBefore) break;
      const oldest = t.main.find((m) => m.status === 'confirmed');
      if (!oldest?.id) break;
      const expectedTimelineEpoch = stateRef.current.timelineEpochs[channelId] ?? 0;
      const { events, hasMore } = await api.messages(channelId, {
        beforeId: oldest.id,
        limit: PAGE_SIZE,
      });
      if ((stateRef.current.timelineEpochs[channelId] ?? 0) !== expectedTimelineEpoch) continue;
      dispatch({ type: 'history-loaded', channelId, events, hasMore, expectedTimelineEpoch });
      void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
        console.warn('failed to cache jump history', err);
      });
      await new Promise((r) => setTimeout(r, 30)); // let the reducer commit
    }
    setHighlightId(event.id);
  };

  // Up-arrow in an empty composer edits your most recent message (Slack-style).
  const [editRequestId, setEditRequestId] = useState<number | null>(null);
  const editLastOwn = () => {
    for (let i = timeline.main.length - 1; i >= 0; i--) {
      const m = timeline.main[i]!;
      if (m.status === 'confirmed' && m.id != null && m.author.id === me.id && m.sessionId == null && !m.deleted) {
        setEditRequestId(m.id);
        return;
      }
    }
  };

  const { createChannel, setArchived, setMute, setPinned, startDm } = useChannelActions({
    dispatch,
    enqueueOp,
    getChannels: () => stateRef.current.channels,
    navigateToChannel: goToChannel,
  });

  const presentUsers = active ? (state.presence[active.id] ?? []) : [];

  // ---- global keyboard: Esc closes the open pane, ⌘K jumps to a channel ----
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (matchesChord(e, SHORTCUTS.commandPalette.keys)) {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
        return;
      }
      if (matchesChord(e, SHORTCUTS.shortcutsHelp.keys)) {
        if (isEditableShortcutTarget(e.target)) return;
        e.preventDefault();
        setShortcutsHelpOpen((v) => !v);
        return;
      }
      if (e.key !== 'Escape' || switcherOpen || shortcutsHelpOpen) return;
      if (isSidebarOpen) {
        setIsSidebarOpen(false);
        return;
      }
      // === mentions-activity additions ===
      if (mainSurface !== 'chat') {
        openChatSurface();
        return;
      }
      const s = stateRef.current;
      if (s.openSessionId) closeSession();
      else if (s.openThreadRootId != null) {
        goToRoute({ surface: 'chat', channelId: s.activeChannelId, sessionId: null, focusSession: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeSession, isSidebarOpen, mainSurface, openChatSurface, shortcutsHelpOpen, switcherOpen]);

  // ---- unread badge in the tab title ----
  const channelUnreadCount = Object.values(state.unread).filter(Boolean).length;
  const unreadCount = channelUnreadCount + activityCounts.attention;
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Atrium` : 'Atrium';
    applyUnreadBadges(unreadCount);
    return () => {
      document.title = 'Atrium';
      applyUnreadBadges(0);
    };
  }, [unreadCount]);

  const startDemoSession = useCallback(async () => {
    if (!active || demoStarting) return;
    setDemoStarting(true);
    try {
      const { session: wire } = await sessionsApi.create({
        channelId: active.id,
        task: 'Demo — watch an agent work',
        harness: 'demo',
        clientSpawnId: `demo-${randomId()}`,
        opId: randomId(),
      });
      const session = sessionFromWire(wire);
      dispatch({ type: 'session-upsert', session });
      openSession(session.id);
    } catch (err) {
      onApiError(err);
      if (!(err instanceof ApiError && err.status === 401)) {
        showErrorToast("Couldn't start the demo agent.");
      }
    } finally {
      setDemoStarting(false);
    }
  }, [active, demoStarting, onApiError]);

  const startVoiceCallForActiveChannel = useCallback(() => {
    if (!callsAvailable) {
      showErrorToast(
        'Voice calls aren’t set up. Configure LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) to enable calls.',
      );
      return;
    }
    if (active) void calls.startCall(active.id);
  }, [active, calls, callsAvailable]);
  const newAgentDisabled = !active;
  const voiceCallDisabled = callsAvailable && (!active || calls.starting || calls.activeCall != null);
  const voiceCallAriaDisabled = !callsAvailable || voiceCallDisabled;
  const voiceCallTooltip = !callsAvailable
    ? 'Voice calls aren’t set up — configure LiveKit to enable'
    : !active
      ? 'Select a channel to start a voice call'
      : calls.activeCall
        ? 'Already in a call'
        : calls.starting
          ? 'Starting call…'
          : 'Start voice call';

  const quickSwitcherCommands = useMemo<QuickSwitcherCommand[]>(() => {
    const list: QuickSwitcherCommand[] = [];
    const activeLabel = active ? channelLabel(active, me.id) : '';
    const activeChannelLabel = active
      ? `${active.kind === 'dm' || active.kind === 'gdm' ? '@' : '#'}${activeLabel}`
      : '';

    if (active) {
      list.push({
        id: 'new-agent',
        label: `New agent in ${activeChannelLabel}`,
        subtitle: 'Open the configured agent dialog',
        group: 'Create',
        keywords: ['agent', 'spawn', 'session', 'new', 'task', activeLabel],
        icon: <PlusIcon size={14} />,
        run: () => {
          openChatSurface();
          setSpawnInitialTask('');
          setSpawnOpen(true);
        },
      });
    }

    if (mainSurface === 'chat' && active) {
      list.push({
        id: 'run-demo-agent',
        label: 'Run demo agent',
        subtitle: `Start the no-setup demo in ${activeChannelLabel}`,
        group: 'Create',
        keywords: ['demo', 'agent', 'session', 'no setup', activeLabel],
        icon: <PlayIcon size={14} />,
        run: () => void startDemoSession(),
      });
    }

    list.push(
      {
        id: 'open-files',
        label: 'Open Files',
        subtitle: active ? `Browse files for ${activeChannelLabel}` : 'Browse workspace files',
        group: 'Navigate',
        keywords: ['files', 'artifacts', 'documents', 'workspace'],
        icon: <FileIcon size={14} />,
        run: openFilesSurface,
      },
      {
        id: 'open-agents',
        label: 'Open Agents',
        subtitle: 'Browse agents',
        group: 'Navigate',
        keywords: ['agents', 'sessions', 'tasks', 'workspace'],
        icon: <span className="text-xs font-bold leading-none">A</span>,
        run: openAgentsSurface,
      },
      {
        id: 'open-activity',
        label: 'Open Inbox',
        subtitle: 'Review mentions and updates',
        group: 'Navigate',
        keywords: ['inbox', 'activity', 'mentions', 'notifications', 'updates'],
        icon: <span className="text-xs font-bold leading-none">@</span>,
        run: openActivitySurface,
      },
    );

    if (mainSurface !== 'chat') {
      list.push({
        id: 'back-to-chat',
        label: 'Back to Chat',
        subtitle: active ? `Return to ${activeChannelLabel}` : 'Return to the current conversation',
        group: 'Navigate',
        keywords: ['chat', 'conversation', 'channel', 'back'],
        icon: <SearchIcon size={14} />,
        run: openChatSurface,
      });
    }

    if (active && (!callsAvailable || (!calls.starting && calls.activeCall == null))) {
      list.push({
        id: 'start-voice-call',
        label: 'Start voice call',
        subtitle: callsAvailable ? `Call ${activeChannelLabel}` : 'Requires LiveKit setup',
        group: 'Communicate',
        keywords: ['voice', 'call', 'phone', 'audio', activeLabel],
        icon: <PhoneIcon size={14} />,
        run: startVoiceCallForActiveChannel,
      });
    }

    list.push(
      {
        id: 'open-settings',
        label: 'Open settings',
        subtitle: 'Theme, notifications, and connections',
        group: 'Workspace',
        keywords: ['settings', 'preferences', 'theme', 'notifications', 'connections'],
        icon: <GearIcon size={14} />,
        run: openSettingsSurface,
      },
      {
        id: 'create-channel',
        label: 'Create channel',
        subtitle: 'Open the channel creation form',
        group: 'Workspace',
        keywords: ['channel', 'create', 'new', 'conversation'],
        icon: <PlusIcon size={14} />,
        run: () => {
          if (isMobileViewport) setIsSidebarOpen(true);
          setCreateChannelRequestSeq((n) => n + 1);
        },
      },
      {
        id: 'start-dm',
        label: 'Start DM',
        subtitle: 'Find a person to message',
        group: 'Workspace',
        keywords: ['dm', 'direct', 'message', 'person', 'chat'],
        icon: <PlusIcon size={14} />,
        run: () => {
          if (isMobileViewport) setIsSidebarOpen(true);
          setStartDmRequestSeq((n) => n + 1);
        },
      },
      {
        id: 'connect-github',
        label: githubConnection?.connected ? 'Manage GitHub' : 'Connect GitHub',
        subtitle: connectionsAvailable ? 'Repository access for agents' : 'Unavailable on this server',
        group: 'Connections',
        keywords: ['github', 'repository', 'repo', 'connection', 'provider'],
        icon: <span className="text-xs font-bold leading-none">GH</span>,
        run: () => setConnectionDialog('github'),
      },
      {
        id: 'connect-claude-code',
        label: providerCredentials['claude-code']?.connected ? 'Manage Claude Code' : 'Connect Claude Code',
        subtitle: 'Configure Claude Code sessions',
        group: 'Connections',
        keywords: ['claude', 'claude code', 'provider', 'connection', 'anthropic'],
        icon: <span className="text-xs font-bold leading-none">C</span>,
        run: () => setProviderDialog('claude-code'),
      },
      {
        id: 'connect-codex',
        label: providerCredentials.codex?.connected ? 'Manage Codex' : 'Connect Codex',
        subtitle: 'Configure Codex sessions',
        group: 'Connections',
        keywords: ['codex', 'openai', 'provider', 'connection'],
        icon: <span className="text-xs font-bold leading-none">CX</span>,
        run: () => setProviderDialog('codex'),
      },
    );

    return list;
  }, [
    active,
    calls.activeCall,
    calls.starting,
    callsAvailable,
    connectionsAvailable,
    githubConnection?.connected,
    isMobileViewport,
    mainSurface,
    me.id,
    openActivitySurface,
    openAgentsSurface,
    openChatSurface,
    openFilesSurface,
    openSettingsSurface,
    providerCredentials,
    startDemoSession,
    startVoiceCallForActiveChannel,
  ]);

  const connectionKind = wsStatusKind(state.wsStatus);
  const connectionServerHost = connectionHost(
    isDesktop
      ? (desktopWsUrl() ?? location.href)
      : browserWsUrl
        ? new URL(browserWsUrl, location.href).toString()
        : location.href,
    location.host || 'server',
  );
  const queueStatus = queueStatusBanner(state.wsStatus, queueSync, connectionServerHost);
  const sidebarWsStatus =
    connectionKind === 'open' ? 'open' : connectionKind === 'connecting' ? 'connecting' : 'closed';
  const currentRoute = useMemo(() => parseInAppRoute(locationState.pathname), [locationState.pathname]);
  const conversationMode = currentRoute?.sessionId ? 'work' : 'thread';
  const attachedThreadSession = openThreadRoot
    ? openThreadRoot.sessionId != null
      ? state.sessions[openThreadRoot.sessionId]
      : Object.values(state.sessions).find((session) => session.threadRootEventId === openThreadRoot.id)
    : undefined;
  // The conversation's identity must not depend on the mode: during a
  // thread→work route flip paneSession settles a render later, and falling
  // back to `undefined` would flip ConversationPanel's key (remount + a second
  // SSE). The thread's attached session IS the same conversation — use it in
  // both modes.
  const conversationSession = paneSession ?? attachedThreadSession;
  const membersRouteOpen =
    currentRoute?.surface === 'chat' &&
    currentRoute.membersOpen === true &&
    currentRoute.channelId != null &&
    currentRoute.channelId === active?.id;
  const showFilesSurface = mainSurface === 'files';
  // === mentions-activity additions ===
  const showActivitySurface = mainSurface === 'activity';
  const showAgentsSurface = mainSurface === 'agents';
  const showSettingsSurface = mainSurface === 'settings';
  const showNonChatSurface = mainSurface !== 'chat';
  const hideMainOnMobile = state.openSessionId != null || openThreadRoot != null;
  const activeChannelLiveCall = !showNonChatSurface && active ? calls.liveCallForChannel(active.id) : null;
  const activeChannelLiveCaller = activeChannelLiveCall
    ? userForCall(activeChannelLiveCall, state.channels, activeChannelLiveCall.initiatorId)
    : null;
  const activeChannelLiveCallName = activeChannelLiveCall
    ? labelForCallChannel(activeChannelLiveCall, state.channels, me.id)
    : '';
  const incomingCaller = calls.incomingCall
    ? userForCall(calls.incomingCall, state.channels, calls.incomingCall.initiatorId)
    : null;
  const incomingChannelName = calls.incomingCall ? labelForCallChannel(calls.incomingCall, state.channels, me.id) : '';
  const showIncomingCallBanner =
    calls.incomingCall != null && incomingCaller != null && calls.incomingCall.id !== activeChannelLiveCall?.id;
  const activeCallChannelName = calls.activeCall
    ? labelForCallChannel(calls.activeCall.call, state.channels, me.id)
    : '';
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
  // === sidebar agent-work additions ===
  const openSessionFromSidebar = useCallback(
    (sessionId: string) => {
      openSession(sessionId);
      setIsSidebarOpen(false);
    },
    [openSession],
  );
  const selectFromSidebar = useCallback(
    (channelId: string) => {
      goToChannel(channelId);
      setIsSidebarOpen(false);
    },
    [goToChannel],
  );
  const openFilesFromSidebar = useCallback(() => {
    openFilesSurface();
    setIsSidebarOpen(false);
  }, [openFilesSurface]);
  const openAgentsFromSidebar = useCallback(() => {
    openAgentsSurface();
    setIsSidebarOpen(false);
  }, [openAgentsSurface]);
  const openActivityFromSidebar = useCallback(() => {
    openActivitySurface();
    setIsSidebarOpen(false);
  }, [openActivitySurface]);
  const openSettingsFromSidebar = useCallback(() => {
    openSettingsSurface();
    setIsSidebarOpen(false);
  }, [openSettingsSurface]);
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={mainSurface === 'chat' ? state.activeChannelId : null}
        unread={state.unread}
        me={me}
        wsStatus={sidebarWsStatus}
        queueSync={queueSync}
        onSelect={selectFromSidebar}
        onSetMute={setMute}
        onSetArchived={setArchived}
        onSetPinned={setPinned}
        onCreateChannel={createChannel}
        onStartDm={startDm}
        activeSurface={mainSurface}
        onOpenFiles={openFilesFromSidebar}
        onOpenAgents={openAgentsFromSidebar}
        // === mentions-activity additions ===
        onOpenActivity={openActivityFromSidebar}
        activityCounts={activityCounts}
        // === sidebar agent-work additions ===
        sessions={state.sessions}
        onOpenSession={openSessionFromSidebar}
        onOpenSettings={openSettingsFromSidebar}
        onLogout={onLogout}
        isOpen={isSidebarOpen}
        onClose={closeSidebar}
        createChannelRequestSeq={createChannelRequestSeq}
        startDmRequestSeq={startDmRequestSeq}
      />

      {view !== 'focus' && (
        <main id="main-content" className={`${hideMainOnMobile ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col`}>
          <header
            className={`flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2 md:gap-3 md:px-4 ${
              isMacDesktop ? 'max-md:pl-20' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open navigation"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-raised text-fg-muted hover:bg-surface-overlay hover:text-fg-body md:hidden"
            >
              <span className="flex flex-col gap-1" aria-hidden="true">
                <span className="block h-px w-4 bg-current" />
                <span className="block h-px w-4 bg-current" />
                <span className="block h-px w-4 bg-current" />
              </span>
            </button>
            <h1
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-bold text-fg md:flex-none"
              aria-label={
                showSettingsSurface
                  ? 'Settings'
                  : showAgentsSurface
                    ? 'Agents'
                    : showActivitySurface
                      ? 'Inbox'
                      : showFilesSurface
                        ? `Files for ${active ? channelLabel(active, me.id) : workspace.name}`
                        : undefined
              }
            >
              {showSettingsSurface ? (
                <>
                  <GearIcon size={16} className="shrink-0 text-fg-muted" />
                  <span className="truncate">Settings</span>
                </>
              ) : showAgentsSurface ? (
                <>
                  <span className="grid size-4 shrink-0 place-items-center rounded bg-surface-raised text-2xs font-bold text-fg-muted">
                    A
                  </span>
                  <span className="truncate">Agents</span>
                </>
              ) : showActivitySurface ? (
                // === mentions-activity additions ===
                <>
                  <span className="grid size-4 shrink-0 place-items-center rounded bg-surface-raised text-2xs font-bold text-fg-muted">
                    @
                  </span>
                  <span className="truncate">Inbox</span>
                  {activityCounts.attention > 0 && (
                    <span className="rounded-full bg-warning-tint px-1.5 py-px text-3xs font-bold text-warning-text-strong">
                      {activityCounts.attention >= 99 ? '99+' : activityCounts.attention}
                      <span className="sr-only"> needs attention</span>
                    </span>
                  )}
                </>
              ) : showFilesSurface ? (
                <>
                  <FileIcon size={16} className="shrink-0 text-fg-muted" />
                  <span className="truncate">Files</span>
                  <span aria-hidden="true" className="hidden text-xs font-medium text-fg-faint sm:inline">
                    /
                  </span>
                  <span className="hidden truncate text-xs font-medium text-fg-muted sm:inline">
                    {active ? channelLabel(active, me.id) : workspace.name}
                  </span>
                </>
              ) : active?.kind === 'dm' || active?.kind === 'gdm' ? (
                <>
                  <Avatar
                    name={channelAvatarName(active, me.id)}
                    seed={dmPartner(active, me.id)?.id ?? active.id}
                    size={18}
                  />
                  {channelLabel(active, me.id)}
                </>
              ) : (
                <>
                  <span className="mr-0.5 shrink-0 text-fg-muted">
                    {active?.kind === 'private' ? <LockIcon size={14} /> : '#'}
                  </span>
                  <span className="truncate">{active?.name ?? '…'}</span>
                </>
              )}
            </h1>
            {!showNonChatSurface &&
              active &&
              (membersRouteOpen || active.kind === 'private' || active.kind === 'gdm') && (
                <ChannelMembersMenu
                  channel={active}
                  meId={me.id}
                  enqueueOp={enqueueOp}
                  onSetArchived={setArchived}
                  onSetPinned={setPinned}
                  open={membersRouteOpen}
                  onOpenChange={(open) => {
                    goToRoute({
                      surface: 'chat',
                      channelId: active.id,
                      sessionId: null,
                      membersOpen: open,
                      focusSession: false,
                    });
                  }}
                />
              )}
            {showNonChatSurface ? (
              <button
                type="button"
                onClick={openChatSurface}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-body md:ml-auto"
              >
                Chat
              </button>
            ) : (
              <Tooltip content={newAgentDisabled ? 'Select a channel to start an agent' : 'New agent'}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (newAgentDisabled) {
                      e.preventDefault();
                      return;
                    }
                    setSpawnInitialTask('');
                    setSpawnOpen(true);
                  }}
                  aria-disabled={newAgentDisabled || undefined}
                  aria-label="New agent"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover aria-disabled:cursor-default aria-disabled:bg-surface-overlay aria-disabled:text-fg-muted md:ml-auto"
                >
                  <PlusIcon size={14} />
                  <span className="hidden sm:inline">New agent</span>
                </button>
              </Tooltip>
            )}
            {!showNonChatSurface && state.openSessionId && (
              <div className="hidden md:flex">
                <ViewToggle view={view} hasSession onSetView={setView} />
              </div>
            )}
            {/* Calls unconfigured: keep the phone visible but grayed with a setup
              hint (tooltip + click), so the feature is discoverable instead of
              hidden — rather than a dead button that fails on click. */}
            {!showNonChatSurface && (
              <Tooltip content={voiceCallTooltip}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (voiceCallDisabled) {
                      e.preventDefault();
                      return;
                    }
                    startVoiceCallForActiveChannel();
                  }}
                  aria-disabled={voiceCallAriaDisabled || undefined}
                  aria-label={!callsAvailable ? 'Voice calls not set up' : 'Start voice call'}
                  className={
                    callsAvailable
                      ? 'rounded-md border border-edge bg-surface-raised px-2 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body aria-disabled:cursor-default aria-disabled:text-fg-faint'
                      : 'rounded-md border border-edge bg-surface-raised px-2 py-1 text-fg-faint cursor-help hover:text-fg-muted'
                  }
                >
                  <PhoneIcon size={15} />
                </button>
              </Tooltip>
            )}
            <Tooltip
              content="Search messages, channels, sessions, and commands"
              shortcut={SHORTCUTS.commandPalette.keys}
            >
              <button
                type="button"
                onClick={() => setSwitcherOpen(true)}
                aria-label="Search and commands"
                className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
              >
                <SearchIcon size={14} />
                <span className="hidden sm:inline">Search</span>
                <kbd className="hidden rounded border border-edge px-1 py-px text-3xs font-medium text-fg-muted lg:inline">
                  ⌘K
                </kbd>
              </button>
            </Tooltip>
            <Tooltip content="Keyboard shortcuts">
              <button
                type="button"
                onClick={() => setShortcutsHelpOpen(true)}
                aria-label="Keyboard shortcuts"
                className="inline-flex items-center justify-center rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
              >
                <span aria-hidden="true" className="leading-none">
                  ?
                </span>
              </button>
            </Tooltip>
            {!showNonChatSurface && presentUsers.length > 0 && (
              <div className="hidden items-center gap-2 md:flex" title="Viewing this channel right now">
                <div className="flex -space-x-1.5">
                  {presentUsers.slice(0, 8).map((u) => (
                    <div key={u.id} className="rounded-md ring-2 ring-surface">
                      <Avatar name={u.displayName} seed={u.id} size={20} />
                    </div>
                  ))}
                </div>
                <span className="text-2xs tabular-nums text-fg-muted">{presentUsers.length} here</span>
              </div>
            )}
          </header>

          {Boolean(
            calls.notice ||
              (showIncomingCallBanner && calls.incomingCall && incomingCaller) ||
              (activeChannelLiveCall && activeChannelLiveCaller && !calls.activeCall) ||
              calls.activeCall,
          ) && (
            <div className="shrink-0 divide-y divide-edge border-b border-edge bg-surface-raised/70">
              {calls.notice && <CallNotice message={calls.notice} onDismiss={calls.clearNotice} />}
              {showIncomingCallBanner && calls.incomingCall && incomingCaller && (
                <IncomingCallBanner
                  call={calls.incomingCall}
                  caller={incomingCaller}
                  channelName={incomingChannelName}
                  answering={calls.answering}
                  onAccept={() => void calls.acceptIncomingCall()}
                  onDecline={() => void calls.declineIncomingCall()}
                />
              )}
              {activeChannelLiveCall && activeChannelLiveCaller && !calls.activeCall && (
                <ChannelCallStrip
                  call={activeChannelLiveCall}
                  caller={activeChannelLiveCaller}
                  channelName={activeChannelLiveCallName}
                  meId={me.id}
                  joining={calls.answering}
                  onJoin={() => void calls.joinCall(activeChannelLiveCall.id)}
                  onDecline={() => void calls.declineCall(activeChannelLiveCall.id)}
                />
              )}
              {calls.activeCall && (
                <InCallPanel
                  call={calls.activeCall}
                  meId={me.id}
                  channelName={activeCallChannelName}
                  onToggleMute={() => void calls.toggleMute()}
                  onLeave={() => void calls.leaveActiveCall()}
                />
              )}
            </div>
          )}

          {queueStatus && (
            <div
              role="status"
              aria-live="polite"
              title={queueStatus.title}
              className="flex shrink-0 items-center justify-center border-b border-warning-border/40 bg-warning-tint/30 px-4 py-1 text-2xs text-warning-text"
            >
              {queueStatus.text}
            </div>
          )}

          {showSettingsSurface ? (
            <SettingsSurface
              githubConnection={githubConnection}
              connectionsAvailable={connectionsAvailable}
              claudeStatus={providerCredentials['claude-code']}
              codexStatus={providerCredentials.codex}
              onConnectGitHub={() => setConnectionDialog('github')}
              onConnectClaude={() => setProviderDialog('claude-code')}
              onConnectCodex={() => setProviderDialog('codex')}
            />
          ) : showAgentsSurface ? (
            <AgentsSurface
              liveSessions={state.sessions}
              refreshKey={sessionEventSeq}
              onOpenSession={(sessionId) => {
                openSession(sessionId);
              }}
              onSetSessionPinned={(sessionId, pinned, previousPinned) =>
                void setSessionPinned(sessionId, pinned, previousPinned).catch(() => {})
              }
              onSetSessionArchived={(sessionId, archived, previousArchivedAt) =>
                void setSessionArchived(sessionId, archived, previousArchivedAt).catch(() => {})
              }
            />
          ) : showActivitySurface ? (
            // === inbox additions ===
            <ActivityView
              onSelectChannel={(channelId) => {
                goToChannel(channelId);
              }}
              onOpenSession={(sessionId) => {
                openSession(sessionId);
              }}
              liveEvent={activityLiveEvent}
              refreshKey={activityRefreshKey}
              liveAttention={liveAttentionItems}
              sessions={state.sessions}
              channelNames={Object.fromEntries(state.channels.map((channel) => [channel.id, channel.name]))}
              onOpenAgents={openAgentsSurface}
              onArchiveSession={(sessionId, previousArchivedAt) =>
                void setSessionArchived(sessionId, true, previousArchivedAt).catch(() => {})
              }
              onCountsChange={handleActivityCountsChange}
            />
          ) : showFilesSurface ? (
            <Gallery
              key={`main-files:${active?.id ?? 'workspace'}`}
              workspaceId={workspace.id}
              channelId={active?.id ?? null}
              filesEventSeq={filesEventSeq}
              onSeedChannelComposer={active ? seedActiveChannelComposer : undefined}
            />
          ) : (
            <EntryQuoteApplyContextProvider
              value={
                active
                  ? { channelId: active.id, sessions: state.sessions, onSpawnNewAgent: openSpawnWithInitialTask }
                  : null
              }
            >
              <Timeline
                key={active?.id ?? 'no-channel'}
                messages={timeline.main}
                loaded={timeline.loaded}
                hasMoreBefore={timeline.hasMoreBefore}
                sessions={state.sessions}
                spectators={spectators}
                meId={me.id}
                meHandle={me.handle}
                mentionContext={
                  active
                    ? {
                        channelId: active.id,
                        includeSpecials: active.kind !== 'dm' && active.kind !== 'gdm',
                        publicChannel: active.kind === 'public',
                      }
                    : undefined
                }
                editRequestId={editRequestId}
                highlightId={highlightId}
                onEditRequestHandled={() => setEditRequestId(null)}
                onLoadEarlier={loadEarlier}
                onOpenThread={openThread}
                onOpenSession={openSession}
                onRunDemoAgent={active ? startDemoSession : undefined}
                demoAgentBusy={demoStarting}
                onInsertAgentCommand={() => putTextInComposer('!!')}
                onSayHello={() => putTextInComposer('Hello!')}
                onConnectProvider={openProviderConnect}
                onRetry={retry}
                onEdit={editMessage}
                onDelete={removeMessage}
                onReact={reactToMessage}
                resolveUser={active ? resolveActiveUser : undefined}
                onMarkupEntry={(handle, message) => void openMarkupReply(handle, message)}
                onDelegateToAgent={(message) =>
                  message.id != null &&
                  channelComposerRef.current?.activateAgentMode({
                    eventId: message.id,
                    label: `/e/${encodeEventHandle(message.id)}`,
                  })
                }
                unreadDividerAfterId={unreadDividerAfterId}
                dividerReady={dividerReady}
                onReachBottom={handleReachBottom}
              />
            </EntryQuoteApplyContextProvider>
          )}

          {/* Composer follows the channel <main>: shown in both channel and split
            views (this block is already inside `view !== 'focus'`). Gating it on
            `!openSessionId` used to blank the composer in split view, leaving the
            channel with no way to type. */}
          {active && !showNonChatSurface && (
            <>
              <TypingLine typing={typing} />
              {/* === channel strip additions === */}
              <ChannelStrip
                channelId={active.id}
                // === true-counts additions ===
                channelCounts={activityChannelCounts[active.id]}
                sessions={state.sessions}
                onOpenSession={openSession}
                onOpenInbox={openActivitySurface}
              />
              <Composer
                ref={channelComposerRef}
                placeholder={
                  active.kind === 'dm' || active.kind === 'gdm'
                    ? `Message ${channelLabel(active, me.id)}`
                    : `Message ${active.kind === 'private' ? '' : '#'}${active.name}`
                }
                onSend={(text, attachments, attachmentRefs, voice) =>
                  send(active.id, text, undefined, attachments, attachmentRefs, voice)
                }
                queueUpload={queueUpload}
                onTyping={() => notifyTyping(active.id)}
                onArrowUpOnEmpty={editLastOwn}
                draftKey={activeDraftKey}
                initialDraft={drafts[activeDraftKey] ?? ''}
                initialDraftAgentIntent={draftAgentIntents[activeDraftKey] ?? false}
                onDraftChange={saveDraft}
                onDraftPersisted={enqueueDraft}
                onDraftTouched={markDraftTouched}
                autoFocus={!state.openSessionId}
                agentMode={{
                  scope: 'channel',
                  channelLabel:
                    active.kind === 'dm' || active.kind === 'gdm' ? channelLabel(active, me.id) : `#${active.name}`,
                }}
                onAgentSend={(request, text, attachments, attachmentRefs) =>
                  sendAgent(active.id, request, text, attachments, attachmentRefs)
                }
                previewEntryLinks
                allowAttachments
                mentionContext={{
                  channelId: active.id,
                  includeSpecials: active.kind !== 'dm' && active.kind !== 'gdm',
                  publicChannel: active.kind === 'public',
                }}
              />
            </>
          )}
        </main>
      )}

      {conversationSession || (openThreadRoot && active) ? (
        <EntryQuoteApplyContextProvider
          value={
            active
              ? { channelId: active.id, sessions: state.sessions, onSpawnNewAgent: openSpawnWithInitialTask }
              : null
          }
        >
          <ConversationPanel
            key={conversationSession?.id ?? `thread:${openThreadRoot?.id ?? 'none'}`}
            mode={conversationMode}
            session={
              conversationSession
                ? {
                    session: conversationSession,
                    me,
                    layout: sessionPaneLayout,
                    onToggleFocus: toggleFocus,
                    watchers: state.presence[`session:${conversationSession.id}`] ?? paneWatchers,
                    typers: Object.values(sessionTyping[conversationSession.id] ?? {}).map((t) => t.user),
                    onComposerTyping: () => notifySessionTyping(conversationSession.id),
                    onClose: closeSession,
                    liveEvent: activityLiveEvent,
                    optimisticThreadSteers: paneOptimisticThreadSteers,
                    origin:
                      active && conversationSession.channelId === active.id
                        ? {
                            channelLabel:
                              active.kind === 'dm' || active.kind === 'gdm'
                                ? channelLabel(active, me.id)
                                : `#${active.name}`,
                            onOpenChannel: closeSession,
                            ...(conversationSession.threadRootEventId != null
                              ? {
                                  onOpenThread: () => {
                                    const root = conversationSession.threadRootEventId;
                                    if (root != null) openThread(root);
                                  },
                                }
                              : {}),
                          }
                        : undefined,
                    onAnswerQuestion: answerSessionQuestion,
                    onSteer: steerSession,
                    queueUpload,
                    failedSteer: failedSteers[conversationSession.id] ?? null,
                    onClearFailedSteer: () => clearFailedSteer(conversationSession.id),
                    onCancelSession: cancelSession,
                    onStopTurn: stopTurn,
                    failedCancel: failedCancels[conversationSession.id] === true,
                    onClearFailedCancel: () => clearFailedCancel(conversationSession.id),
                    onSetArchived: (sessionId, archived, previousArchivedAt) =>
                      void setSessionArchived(sessionId, archived, previousArchivedAt).catch(() => {}),
                    onSetPinned: (sessionId, pinned, previousPinned) =>
                      void setSessionPinned(sessionId, pinned, previousPinned).catch(() => {}),
                    providerCredentials,
                    githubConnection,
                    onConnectProvider: setProviderDialog,
                    onConnectGitHub: () => setConnectionDialog('github'),
                    agentProfiles,
                    onDiscussEntry: openDiscussThread,
                    onApiError,
                    initialEntryHandle: pendingEntryHandle?.startsWith('rec_') ? pendingEntryHandle : null,
                  }
                : undefined
            }
            thread={
              openThreadRoot && active
                ? {
                    root: openThreadRoot,
                    replies: threadReplies,
                    loaded: threadLoaded,
                    sessions: state.sessions,
                    spectators,
                    meId: me.id,
                    meHandle: me.handle,
                    mentionContext: {
                      channelId: active.id,
                      includeSpecials: active.kind !== 'dm' && active.kind !== 'gdm',
                      publicChannel: active.kind === 'public',
                    },
                    channelLabel:
                      active.kind === 'dm' || active.kind === 'gdm' ? channelLabel(active, me.id) : `#${active.name}`,
                    onClose: () =>
                      goToRoute({ surface: 'chat', channelId: active.id, sessionId: null, focusSession: false }),
                    onSend: (text, attachments, attachmentRefs, voice, broadcast) =>
                      send(active.id, text, openThreadRoot.id!, attachments, attachmentRefs, voice, broadcast),
                    onAgentSend: (request, text, attachments, attachmentRefs) =>
                      sendAgent(active.id, request, text, attachments, attachmentRefs),
                    queueUpload,
                    onOpenSession: openSession,
                    onRetry: retry,
                    onEdit: editMessage,
                    onDelete: removeMessage,
                    onReact: reactToMessage,
                    resolveUser: resolveActiveUser,
                    onMarkupEntry: (handle, message) => void openMarkupReply(handle, message),
                    draftKey: threadDraftKey,
                    initialDraft: drafts[threadDraftKey] ?? '',
                    initialDraftAgentIntent: draftAgentIntents[threadDraftKey] ?? false,
                    onDraftChange: saveDraft,
                    onDraftPersisted: enqueueDraft,
                    onDraftTouched: markDraftTouched,
                    previewEntryLinks: true,
                  }
                : undefined
            }
          />
        </EntryQuoteApplyContextProvider>
      ) : state.openSessionId ? (
        <aside
          className={`flex min-w-0 flex-col border-l border-edge bg-surface ${
            isMobileViewport || view === 'focus' ? 'flex-1' : `shrink-0 ${placeholderPaneSizing.className}`
          }`}
          style={isMobileViewport || view === 'focus' ? undefined : placeholderPaneSizing.style}
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
            <h2 className="text-sm font-semibold text-fg">Session</h2>
            <Tooltip content="Close session details">
              <button
                type="button"
                onClick={closeSession}
                aria-label="Close session details"
                className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
              >
                <XIcon />
              </button>
            </Tooltip>
          </header>
          {state.openSessionError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="text-sm font-medium text-fg-secondary">Agent not found</div>
              <div className="text-xs text-fg-muted">It may have been removed, or the link is wrong.</div>
              <button
                type="button"
                onClick={closeSession}
                className="mt-2 rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading session…</div>
          )}
        </aside>
      ) : null}

      {switcherOpen && (
        <QuickSwitcher
          channels={state.channels}
          activeChannelId={state.activeChannelId}
          meId={me.id}
          commands={quickSwitcherCommands}
          onSelect={(channelId) => {
            goToChannel(channelId);
            setSwitcherOpen(false);
          }}
          onJumpToMessage={(event) => {
            setSwitcherOpen(false);
            void jumpToMessage(event);
          }}
          onOpenSession={(sessionId) => {
            openSession(sessionId);
            setSwitcherOpen(false);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      <ShortcutsHelp open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />

      {spawnOpen && active && (
        <SpawnDialog
          key={`spawn:${spawnInitialTask}`}
          channelName={
            active.kind === 'dm' || active.kind === 'gdm'
              ? channelLabel(active, me.id)
              : `${active.kind === 'private' ? '' : '#'}${active.name}`
          }
          initialTask={spawnInitialTask}
          onCancel={cancelSpawnDialog}
          onSpawn={(config) => {
            setConfigureRestore(null);
            startConfiguredSession(config);
          }}
          providerStatuses={providerCredentials}
          githubConnection={githubConnection}
          connectionsAvailable={connectionsAvailable}
          profiles={agentProfiles}
          onConnectGitHub={() => setConnectionDialog('github')}
          onConnectProvider={setProviderDialog}
        />
      )}

      {markupSource && markupMode && (
        <MarkupPane
          source={markupSource}
          mode={markupMode}
          onClose={() => {
            setMarkupSource(null);
            setMarkupMode(null);
          }}
          onSendThreadReply={({ channelId, threadRootEventId, text }) => {
            send(channelId, text, threadRootEventId);
            goToRoute({
              surface: 'chat',
              channelId,
              sessionId: null,
              threadRootId: String(threadRootEventId),
              focusSession: false,
            });
          }}
        />
      )}

      {connectionDialog === 'github' && (
        <GitHubConnectionDialog
          available={connectionsAvailable}
          status={githubConnection}
          onCancel={() => setConnectionDialog(null)}
          onConnect={connectGitHub}
          onActivate={activateGitHubIdentity}
          onDisconnect={disconnectGitHub}
        />
      )}

      {providerDialog === 'claude-code' && (
        <ClaudeConnectDialog
          status={providerCredentials['claude-code']}
          onCancel={() => setProviderDialog(null)}
          onSave={saveClaudeToken}
          onDisconnect={disconnectClaude}
        />
      )}

      {providerDialog === 'codex' && (
        <CodexConnectDialog
          status={providerCredentials.codex}
          onCancel={() => setProviderDialog(null)}
          onSave={saveCodexAuthJson}
          onDisconnect={disconnectCodex}
        />
      )}
    </div>
  );
}

/** Fixed-height "X is typing…" line — always present so the layout never shifts. */
function TypingLine({ typing }: { typing: Record<string, { user: UserRef; until: number }> }) {
  const names = Object.values(typing).map((t) => t.user.displayName);
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : 'Several people are typing…';
  return (
    <div aria-live="polite" className="h-5 shrink-0 px-4 text-2xs leading-5 text-fg-muted">
      {label}
    </div>
  );
}
