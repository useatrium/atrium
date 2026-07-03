import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, type Workspace, api } from './api';
import { isDesktop, desktopWsUrl, setDesktopBadge } from './desktop';
import {
  DurableOpQueue,
  FILES_CHANGED_EVENT_TYPE,
  appReducer,
  filesChangedWorkspaceId,
  queuedChangesLabel,
  dispatchSyncSnapshot,
  dispatchSyncResponse,
  initialAppState,
  randomId,
  type EnqueueOpInput,
  type OpType,
  useQueuedChangesCount,
} from '@atrium/surface-client';
import { showNotification } from './notify';
import { emptyTimeline, type UserRef, type WireEvent } from '@atrium/surface-client';
import { useWs } from '@atrium/surface-client';
import { Avatar } from './components/Avatar';
import { ActivityView } from './components/ActivityView';
import { labelForCallChannel, userForCall } from './callPresentation';
import { notificationForWireEvent } from './chatNotifications';
import { ChannelMembersMenu } from './components/ChannelMembersMenu';
import { CallNotice, ChannelCallStrip, InCallPanel, IncomingCallBanner } from './components/CallUI';
import { ClaudeConnectDialog } from './components/ClaudeConnectDialog';
import { CodexConnectDialog } from './components/CodexConnectDialog';
import { Composer } from './components/Composer';
import { GitHubConnectionDialog } from './components/GitHubConnectionDialog';
import { EntryQuoteApplyContextProvider } from './components/EntryQuoteCard';
import { FileIcon, GearIcon, LockIcon, PhoneIcon, PlayIcon, PlusIcon, SearchIcon, XIcon } from './components/icons';
import { MarkupPane, splitMarkdownFrontmatter, type MarkupPaneMode, type MarkupPaneSource } from './components/MarkupPane';
import { showErrorToast } from './components/Toasts';
import { QuickSwitcher, type QuickSwitcherCommand } from './components/QuickSwitcher';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';
import { sessionsApi } from './sessions/api';
import { sessionsMockBus } from './sessions/devMock';
import { FilesHub } from './sessions/FilesHub';
import { SessionPane, type TranscriptDiscussPayload } from './sessions/SessionPane';
import { loadSessionPaneWidth, sessionPaneSizing } from './sessions/useSessionPaneWidth';
import { SessionsRail } from './sessions/SessionsRail';
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
import {
  entryParamFromSearch,
  fileParamFromSearch,
  stripEntryParamFromLocation,
  threadRootParamFromSearch,
} from './EntryLinkRoute';

const PAGE_SIZE = 50;
const SYNC_LIMIT = 500;
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
const browserWsUrl = import.meta.env.VITE_ATRIUM_WS_URL?.trim();
type MainSurface = 'chat' | 'files' | 'activity';

// === web-client additions ===
type NotificationClickTarget = {
  channelId?: string;
  eventId?: string | number;
  sessionId?: string;
};

function notificationClickTarget(input: unknown): NotificationClickTarget | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const channelId = typeof raw.channelId === 'string' ? raw.channelId : undefined;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
  const eventId = typeof raw.eventId === 'string' || typeof raw.eventId === 'number' ? raw.eventId : undefined;
  if (!channelId && !sessionId && eventId === undefined) return null;
  return {
    ...(channelId ? { channelId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
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
// === web-client additions ===

type EnqueueOpOptions = {
  onStored?: () => void;
};

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
    : false;
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

export function Chat({
  me,
  workspace,
  initialSessionId,
  initialChannelId,
  initialEntryHandle,
  initialThreadRootEventId,
  onLogout,
}: {
  me: UserRef;
  workspace: Workspace;
  /** From the /s/:id permalink route — open this session's pane on load. */
  initialSessionId?: string | null;
  /** From /e/:handle event/artifact links — select this channel on load. */
  initialChannelId?: string | null;
  /** Entry handle from ?entry=... for one-shot scroll/highlight handling. */
  initialEntryHandle?: string | null;
  /** Thread root from /e/:handle reply links. Usually read from the rewritten URL. */
  initialThreadRootEventId?: number | null;
  onLogout: () => void;
}) {
  const { prefs } = useTheme();
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [sessionEventSeq, setSessionEventSeq] = useState(0);
  const { clearFailedCancel, clearFailedSteer, failedCancels, failedSteers, rememberRejectedSessionOp } =
    useSessionQueueFailures();
  const calls = useCall(me, state.channels);
  const callsAvailable = useCallsAvailable();
  const stateRef = useRef(state);
  stateRef.current = state;
  const authInvalidatedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [queueNudgeSeq, setQueueNudgeSeq] = useState(0);
  const [unreadDividerAfterId, setUnreadDividerAfterId] = useState<number | null>(null);
  const selectChannel = useCallback((channelId: string) => {
    const channel = stateRef.current.channels.find((c) => c.id === channelId);
    const lastRead = channel?.lastReadEventId ?? 0;
    const latest = channel?.latestEventId ?? 0;
    setUnreadDividerAfterId(lastRead > 0 && latest > lastRead ? lastRead : null);
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

  // === web-client additions ===
  const openNotificationTarget = useCallback(
    (target: NotificationClickTarget) => {
      if (target.channelId) selectChannel(target.channelId);
      if (target.sessionId) dispatch({ type: 'open-session', sessionId: target.sessionId });
    },
    [selectChannel],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const channelId = params.get('channel') ?? undefined;
    const sessionId = params.get('session') ?? undefined;
    if (!channelId && !sessionId) return;
    openNotificationTarget({
      ...(channelId ? { channelId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
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
    },
    [cacheMute, cacheSyncCursor, handleFilesChangedEvent],
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

  const { markRead, noteReadCursor } = useReadMarks({ dispatch, enqueueOp, onApiError });

  const { answerSessionQuestion, cancelSession, steerSession, stopTurn } = useSessionActions({
    clearFailedCancel,
    clearFailedSteer,
    enqueueOp,
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

  const queuedChangesCount = useQueuedChangesCount(eventCache, state.wsStatus, queueNudgeSeq);

  useEffect(() => {
    const flushHiddenCache = () => {
      if (document.visibilityState !== 'hidden') return;
      void eventCache.flushAll().catch((err: unknown) => {
        console.warn('failed to flush event cache on hide', err);
      });
    };
    document.addEventListener('visibilitychange', flushHiddenCache);
    return () => document.removeEventListener('visibilitychange', flushHiddenCache);
  }, []);

  const { queueUpload } = useUploadQueue({ enqueueOp, storage: eventCache });

  const applyQueuedOp = useCallback(
    (op: Parameters<typeof queuedOverlayAction>[0]) => {
      const overlay = queuedOverlayAction(op, me);
      if (!overlay) return;
      if (overlay.readCursor) {
        noteReadCursor(overlay.readCursor.channelId, overlay.readCursor.lastReadEventId);
      }
      dispatch(overlay.action);
    },
    [me, noteReadCursor],
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
  const [mainSurface, setMainSurface] = useState<MainSurface>('chat');
  const [settingsRequestSeq, setSettingsRequestSeq] = useState(0);
  const [createChannelRequestSeq, setCreateChannelRequestSeq] = useState(0);
  const [startDmRequestSeq, setStartDmRequestSeq] = useState(0);
  // Configured-spawn dialog (the @agent composer grammar is the quick path).
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnInitialTask, setSpawnInitialTask] = useState('');
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

  // ---- permalink (/s/:id): load the session, jump to its channel, open pane ----
  useEffect(() => {
    if (!initialSessionId) return;
    dispatch({ type: 'open-session', sessionId: initialSessionId });
    setFocused(true); // permalinks land in Focus
    sessionsApi
      .get(initialSessionId)
      .then(({ session }) => {
        dispatch({ type: 'session-upsert', session: sessionFromWire(session) });
        if (session.channelId) selectChannel(session.channelId);
        dispatch({ type: 'open-session', sessionId: session.id });
      })
      .catch(() => dispatch({ type: 'session-load-failed', sessionId: initialSessionId }));
  }, [initialSessionId, selectChannel]);

  const initialChannelSelectedRef = useRef(false);
  useEffect(() => {
    if (!initialChannelId || initialChannelSelectedRef.current) return;
    initialChannelSelectedRef.current = true;
    selectChannel(initialChannelId);
    setMainSurface('chat');
  }, [initialChannelId, selectChannel]);

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

  // Keep the URL in sync with the open pane so it is copyable as a permalink.
  useEffect(() => {
    const path = state.openSessionId && !isPendingSessionId(state.openSessionId) ? `/s/${state.openSessionId}` : '/';
    if (location.pathname !== path) history.replaceState(null, '', path);
  }, [state.openSessionId]);

  // ---- DEV MOCK (sessions): fold synthetic session.* events; no-op without
  // VITE_SESSIONS_MOCK=1. Delete with src/sessions/devMock.ts. ----
  useEffect(() => sessionsMockBus?.subscribe((event: WireEvent) => dispatch({ type: 'server-event', event })), []);

  const active = state.channels.find((c) => c.id === state.activeChannelId) ?? null;
  const timeline = (active && state.timelines[active.id]) || emptyTimeline;
  const openThreadRoot =
    state.openThreadRootId != null ? (timeline.main.find((m) => m.id === state.openThreadRootId) ?? null) : null;
  const threadReplies = state.openThreadRootId != null ? (timeline.threads[state.openThreadRootId] ?? []) : [];
  const threadLoaded = state.openThreadRootId != null && timeline.threads[state.openThreadRootId] !== undefined;
  const activeDraftKey = active ? `channel:${active.id}` : '';
  const threadDraftKey = active && openThreadRoot?.id != null ? `channel:${active.id}:thread:${openThreadRoot.id}` : '';
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
  const { drafts, enqueueDraft, markDraftTouched, putTextInComposer, reconcileDraftsFromSnapshot, saveDraft } =
    useDraftState({
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
    opQueue.nudge();
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
      const response = await api.sync(cursor, { limit: SYNC_LIMIT });
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
        dispatch({ type: 'read-cursor', channelId, lastReadEventId });
      },
      onMuted: (channelId, muted) => {
        dispatch({ type: 'mute-changed', channelId, muted });
        cacheMute(channelId, muted);
      },
      onChannelLeft: (channelId) => dispatch({ type: 'channel-removed', channelId }),
      onPrefs: adoptPrefs,
      onOpen: () => {
        syncThenFlushQueuedOps();
      },
      onStatus: (status) => dispatch({ type: 'ws-status', status }),
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
        if (notification.channelId) selectChannel(notification.channelId);
      });
      return;
    }
    showNotification(notification.title, notification.body, notification.tag, () => {
      dispatch({ type: 'open-session', sessionId: notification.sessionId });
    });
  }

  // ---- channel selection & history ----
  useEffect(() => {
    if (active) markRead(active.id, timeline.lastEventId);
  }, [active?.id, markRead, timeline.lastEventId]);

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
      .then(({ events, hasMore }) => {
        // Skip if we lost access (kicked from a private channel) while the
        // fetch was in flight — avoids a ghost timeline.
        if (!stateRef.current.channels.some((c) => c.id === channelId)) return;
        dispatch({
          type: needsColdCounterRepair ? 'history-reset' : 'history-loaded',
          channelId,
          events,
          hasMore,
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
      .then(({ events, hasMore }) => {
        if ((stateRef.current.timelineEpochs[channelId] ?? 0) !== expectedTimelineEpoch) return;
        dispatch({ type: 'history-loaded', channelId, events, hasMore, expectedTimelineEpoch });
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
      dispatch({ type: 'open-thread', rootEventId });
      const { events } = await api.thread(rootEventId);
      dispatch({ type: 'thread-loaded', channelId, rootEventId, events });
      return true;
    },
    [ensureTopLevelEventLoaded],
  );

  // ---- thread panel ----
  const openThread = (rootEventId: number) => {
    if (!active) return;
    void openThreadInChannel(active.id, rootEventId).catch(onApiError);
  };

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
      setMainSurface('chat');
      selectChannel(payload.channelId);
      dispatch({ type: 'close-session' });
      const draftKey = threadDraftKeyFor(payload.channelId, payload.threadRootEventId);
      markDraftTouched(draftKey);
      void saveDraft(draftKey, payload.draft);
      void openThreadInChannel(payload.channelId, payload.threadRootEventId)
        .then((opened) => {
          if (opened) putTextInLastComposer(payload.draft);
        })
        .catch(onApiError);
    },
    [markDraftTouched, onApiError, openThreadInChannel, saveDraft, selectChannel],
  );

  const seedActiveChannelComposer = useCallback(
    (draft: string) => {
      setMainSurface('chat');
      dispatch({ type: 'close-thread' });
      putTextInComposer(draft);
    },
    [putTextInComposer],
  );

  const openSpawnWithInitialTask = useCallback((task: string) => {
    setSpawnInitialTask(task);
    setSpawnOpen(true);
  }, []);

  const {
    hasChannelSessions,
    openSession,
    paneSession,
    paneWatchers,
    sessionPaneLayout,
    setFocused,
    setView,
    spectators,
    toggleFocus,
    view,
  } = useSessionPaneState({
    activeChannel: active,
    dispatch,
    isMobileViewport,
    openSessionId: state.openSessionId,
    presence: state.presence,
    sessions: state.sessions,
  });
  // Match SessionPane's persisted width so the pane doesn't jump when it
  // replaces the loading placeholder; read storage once per opened session,
  // not on every Chat render.
  const placeholderPaneSizing = useMemo(() => sessionPaneSizing(loadSessionPaneWidth()), [state.openSessionId]);

  const { editMessage, reactToMessage, removeMessage, retry, send, startConfiguredSession } = useChatMessageActions({
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
  const [pendingFileArtifactId, setPendingFileArtifactId] = useState<string | null>(() => {
    return typeof window === 'undefined' ? null : fileParamFromSearch(window.location.search);
  });
  useEffect(() => {
    if (highlightId == null) return;
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId]);

  useEffect(() => {
    if (!pendingFileArtifactId || !active) return;
    setMainSurface('files');
    stripEntryParamFromLocation();
  }, [active, pendingFileArtifactId]);

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
    selectChannel(channelId);
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

  const { createChannel, setMute, startDm } = useChannelActions({
    dispatch,
    enqueueOp,
    getChannels: () => stateRef.current.channels,
    selectChannel,
  });

  const presentUsers = active ? (state.presence[active.id] ?? []) : [];

  // ---- global keyboard: Esc closes the open pane, ⌘K jumps to a channel ----
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
        return;
      }
      if (e.key !== 'Escape' || switcherOpen) return;
      if (isSidebarOpen) {
        setIsSidebarOpen(false);
        return;
      }
      // === mentions-activity additions ===
      if (mainSurface === 'files' || mainSurface === 'activity') {
        setMainSurface('chat');
        return;
      }
      const s = stateRef.current;
      if (s.openSessionId) dispatch({ type: 'close-session' });
      else if (s.openThreadRootId != null) dispatch({ type: 'close-thread' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSidebarOpen, mainSurface, switcherOpen]);

  // ---- unread badge in the tab title ----
  const unreadCount = Object.values(state.unread).filter(Boolean).length;
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
          setMainSurface('chat');
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
        run: () => setMainSurface('files'),
      },
      {
        id: 'open-activity',
        label: 'Open Activity',
        subtitle: 'Review mentions and updates',
        group: 'Navigate',
        keywords: ['activity', 'mentions', 'notifications', 'updates'],
        icon: <span className="text-xs font-bold leading-none">@</span>,
        run: () => setMainSurface('activity'),
      },
    );

    if (mainSurface === 'files' || mainSurface === 'activity') {
      list.push({
        id: 'back-to-chat',
        label: 'Back to Chat',
        subtitle: active ? `Return to ${activeChannelLabel}` : 'Return to the current conversation',
        group: 'Navigate',
        keywords: ['chat', 'conversation', 'channel', 'back'],
        icon: <SearchIcon size={14} />,
        run: () => setMainSurface('chat'),
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
        run: () => {
          if (isMobileViewport) setIsSidebarOpen(true);
          setSettingsRequestSeq((n) => n + 1);
        },
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
        subtitle: connectionsAvailable ? 'Repository access for agent sessions' : 'Unavailable on this server',
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
    providerCredentials,
    startDemoSession,
    startVoiceCallForActiveChannel,
  ]);

  const queueStatusText = queuedChangesLabel(state.wsStatus, queuedChangesCount);
  const showFilesSurface = mainSurface === 'files';
  // === mentions-activity additions ===
  const showActivitySurface = mainSurface === 'activity';
  const activeChannelLiveCall =
    !showFilesSurface && !showActivitySurface && active ? calls.liveCallForChannel(active.id) : null;
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
    calls.incomingCall != null &&
    incomingCaller != null &&
    calls.incomingCall.id !== activeChannelLiveCall?.id;
  const activeCallChannelName = calls.activeCall
    ? labelForCallChannel(calls.activeCall.call, state.channels, me.id)
    : '';
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={mainSurface === 'chat' ? state.activeChannelId : null}
        unread={state.unread}
        me={me}
        wsStatus={state.wsStatus}
        onSelect={(channelId) => {
          selectChannel(channelId);
          setMainSurface('chat');
          setIsSidebarOpen(false);
        }}
        onSetMute={setMute}
        onCreateChannel={createChannel}
        onStartDm={startDm}
        onOpenSession={(sessionId) => {
          openSession(sessionId);
          setMainSurface('chat');
          setIsSidebarOpen(false);
        }}
        activeSurface={mainSurface}
        onOpenFiles={() => {
          setMainSurface('files');
          setIsSidebarOpen(false);
        }}
        // === mentions-activity additions ===
        onOpenActivity={() => {
          setMainSurface('activity');
          setIsSidebarOpen(false);
        }}
        sessionEventSeq={sessionEventSeq}
        githubConnection={githubConnection}
        connectionsAvailable={connectionsAvailable}
        providerCredentials={providerCredentials}
        onConnectGitHub={() => setConnectionDialog('github')}
        onConnectProvider={setProviderDialog}
        onLogout={onLogout}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        settingsRequestSeq={settingsRequestSeq}
        createChannelRequestSeq={createChannelRequestSeq}
        startDmRequestSeq={startDmRequestSeq}
      />

      {view !== 'focus' && (
        <main className={`${state.openSessionId ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col`}>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2 md:gap-3 md:px-4">
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
                showActivitySurface
                  ? 'Activity'
                  : showFilesSurface
                    ? `Files for ${active ? channelLabel(active, me.id) : workspace.name}`
                    : undefined
              }
            >
              {showActivitySurface ? (
                // === mentions-activity additions ===
                <>
                  <span className="grid size-4 shrink-0 place-items-center rounded bg-surface-raised text-2xs font-bold text-fg-muted">
                    @
                  </span>
                  <span className="truncate">Activity</span>
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
            {!showFilesSurface &&
              !showActivitySurface &&
              active &&
              (active.kind === 'private' || active.kind === 'gdm') && (
                <ChannelMembersMenu channel={active} meId={me.id} enqueueOp={enqueueOp} />
              )}
            {showFilesSurface || showActivitySurface ? (
              <button
                type="button"
                onClick={() => setMainSurface('chat')}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-body md:ml-auto"
              >
                Chat
              </button>
            ) : (
              <button
                onClick={() => {
                  setSpawnInitialTask('');
                  setSpawnOpen(true);
                }}
                disabled={!active}
                title="New agent"
                aria-label="New agent"
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted md:ml-auto"
              >
                <PlusIcon size={14} />
                <span className="hidden sm:inline">New agent</span>
              </button>
            )}
            {!showFilesSurface && !showActivitySurface && state.openSessionId && (
              <div className="hidden md:flex">
                <ViewToggle view={view} hasSession onSetView={setView} />
              </div>
            )}
            {/* Calls unconfigured: keep the phone visible but grayed with a setup
              hint (tooltip + click), so the feature is discoverable instead of
              hidden — rather than a dead button that fails on click. */}
            {!showFilesSurface && !showActivitySurface && (
              <button
                onClick={startVoiceCallForActiveChannel}
                disabled={callsAvailable && (!active || calls.starting || calls.activeCall != null)}
                aria-disabled={!callsAvailable || undefined}
                title={
                  !callsAvailable
                    ? 'Voice calls aren’t set up — configure LiveKit to enable'
                    : calls.activeCall
                      ? 'Already in a call'
                      : calls.starting
                        ? 'Starting call…'
                        : 'Start voice call'
                }
                aria-label={!callsAvailable ? 'Voice calls not set up' : 'Start voice call'}
                className={
                  callsAvailable
                    ? 'rounded-md border border-edge bg-surface-raised px-2 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:cursor-default disabled:text-fg-faint'
                    : 'rounded-md border border-edge bg-surface-raised px-2 py-1 text-fg-faint cursor-help hover:text-fg-muted'
                }
              >
                <PhoneIcon size={15} />
              </button>
            )}
            <button
              onClick={() => setSwitcherOpen(true)}
              aria-label="Open command center"
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
            >
              <SearchIcon size={14} />
              <span className="hidden sm:inline">Command</span>
              <kbd className="hidden rounded border border-edge px-1 py-px text-3xs font-medium text-fg-muted lg:inline">
                ⌘K
              </kbd>
            </button>
            {!showFilesSurface && presentUsers.length > 0 && (
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

          {queueStatusText && (
            <div
              role="status"
              aria-live="polite"
              className={`flex shrink-0 items-center justify-center border-b px-4 py-1 text-2xs ${
                state.wsStatus === 'open'
                  ? 'border-info/20 bg-info/10 text-info-text'
                  : 'border-warning-border/40 bg-warning-tint/30 text-warning-text'
              }`}
            >
              {queueStatusText}
            </div>
          )}

          {showActivitySurface ? (
            // === mentions-activity additions ===
            <ActivityView
              onSelectChannel={(channelId) => {
                selectChannel(channelId);
                setMainSurface('chat');
              }}
              onOpenSession={(sessionId) => {
                openSession(sessionId);
                setMainSurface('chat');
              }}
            />
          ) : showFilesSurface ? (
            <FilesHub
              key={`main-files:${active?.id ?? 'workspace'}`}
              workspaceId={workspace.id}
              channelId={active?.id ?? null}
              defaultScope={active ? 'channel' : 'workspace'}
              filesEventSeq={filesEventSeq}
              sessions={state.sessions}
              initialOpenArtifactId={pendingFileArtifactId}
              onInitialOpenArtifactHandled={(artifactId) => {
                if (pendingFileArtifactId === artifactId) setPendingFileArtifactId(null);
              }}
              onSeedChannelComposer={active ? seedActiveChannelComposer : undefined}
              onStartAgentWithTask={active ? openSpawnWithInitialTask : undefined}
            />
          ) : (
            <EntryQuoteApplyContextProvider value={active ? { channelId: active.id, sessions: state.sessions, onSpawnNewAgent: openSpawnWithInitialTask } : null}>
              <Timeline
                messages={timeline.main}
                loaded={timeline.loaded}
                hasMoreBefore={timeline.hasMoreBefore}
                sessions={state.sessions}
                spectators={spectators}
                meId={me.id}
                meHandle={me.handle}
                editRequestId={editRequestId}
                highlightId={highlightId}
                onEditRequestHandled={() => setEditRequestId(null)}
                onLoadEarlier={loadEarlier}
                onOpenThread={openThread}
                onOpenSession={openSession}
                onRunDemoAgent={active ? startDemoSession : undefined}
                demoAgentBusy={demoStarting}
                onInsertAgentCommand={() => putTextInComposer('@agent ')}
                onSayHello={() => putTextInComposer('Hello!')}
                onConnectProvider={openProviderConnect}
                onRetry={retry}
                onEdit={editMessage}
                onDelete={removeMessage}
                onReact={reactToMessage}
                onMarkupEntry={(handle, message) => void openMarkupReply(handle, message)}
                unreadDividerAfterId={unreadDividerAfterId}
              />
            </EntryQuoteApplyContextProvider>
          )}

          {/* Composer follows the channel <main>: shown in both channel and split
            views (this block is already inside `view !== 'focus'`). Gating it on
            `!openSessionId` used to blank the composer in split view, leaving the
            channel with no way to type. */}
          {active && !showFilesSurface && !showActivitySurface && (
            <>
              <TypingLine typing={typing} />
              <Composer
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
                onDraftChange={saveDraft}
                onDraftPersisted={enqueueDraft}
                onDraftTouched={markDraftTouched}
                autoFocus={!state.openSessionId}
                agentAware
                allowAttachments
              />
            </>
          )}
        </main>
      )}

      {paneSession ? (
        <SessionPane
          key={paneSession.id} // full reset (stream, seat anchors, tool state) per session
          session={paneSession}
          me={me}
          layout={sessionPaneLayout}
          onToggleFocus={toggleFocus}
          watchers={paneWatchers}
          typers={Object.values(sessionTyping[paneSession.id] ?? {}).map((t) => t.user)}
          onComposerTyping={() => notifySessionTyping(paneSession.id)}
          onClose={() => dispatch({ type: 'close-session' })}
          onAnswerQuestion={answerSessionQuestion}
          onSteer={steerSession}
          queueUpload={queueUpload}
          failedSteer={failedSteers[paneSession.id] ?? null}
          onClearFailedSteer={() => clearFailedSteer(paneSession.id)}
          onCancelSession={cancelSession}
          onStopTurn={stopTurn}
          failedCancel={failedCancels[paneSession.id] === true}
          onClearFailedCancel={() => clearFailedCancel(paneSession.id)}
          providerCredentials={providerCredentials}
          githubConnection={githubConnection}
          onConnectProvider={setProviderDialog}
          onConnectGitHub={() => setConnectionDialog('github')}
          agentProfiles={agentProfiles}
          onDiscussEntry={openDiscussThread}
          initialEntryHandle={pendingEntryHandle?.startsWith('rec_') ? pendingEntryHandle : null}
        />
      ) : state.openSessionId ? (
        <aside
          className={`flex min-w-0 flex-col border-l border-edge bg-surface ${
            isMobileViewport || view === 'focus' ? 'flex-1' : `shrink-0 ${placeholderPaneSizing.className}`
          }`}
          style={isMobileViewport || view === 'focus' ? undefined : placeholderPaneSizing.style}
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
            <h2 className="text-sm font-semibold text-fg">Session</h2>
            <button
              onClick={() => dispatch({ type: 'close-session' })}
              title="Close session pane"
              aria-label="Close session pane"
              className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
            >
              <XIcon />
            </button>
          </header>
          {state.openSessionError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="text-sm font-medium text-fg-secondary">Session not found</div>
              <div className="text-xs text-fg-muted">It may have been removed, or the link is wrong.</div>
              <button
                onClick={() => dispatch({ type: 'close-session' })}
                className="mt-2 rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading session…</div>
          )}
        </aside>
      ) : openThreadRoot && active ? (
        <div className="hidden md:contents">
          <EntryQuoteApplyContextProvider value={{ channelId: active.id, sessions: state.sessions, onSpawnNewAgent: openSpawnWithInitialTask }}>
            <ThreadPanel
              root={openThreadRoot}
              replies={threadReplies}
              loaded={threadLoaded}
              sessions={state.sessions}
              spectators={spectators}
              meId={me.id}
              meHandle={me.handle}
              onClose={() => dispatch({ type: 'close-thread' })}
              onSend={(text, attachments, attachmentRefs, voice) =>
                send(active.id, text, openThreadRoot.id!, attachments, attachmentRefs, voice)
              }
              queueUpload={queueUpload}
              onOpenSession={openSession}
              onRetry={retry}
              onEdit={editMessage}
              onDelete={removeMessage}
              onReact={reactToMessage}
              onMarkupEntry={(handle, message) => void openMarkupReply(handle, message)}
              draftKey={threadDraftKey}
              initialDraft={drafts[threadDraftKey] ?? ''}
              onDraftChange={saveDraft}
              onDraftPersisted={enqueueDraft}
              onDraftTouched={markDraftTouched}
            />
          </EntryQuoteApplyContextProvider>
        </div>
      ) : (
        active &&
        hasChannelSessions && (
          <div className="hidden md:contents">
            <SessionsRail channelId={active.id} sessions={state.sessions} onOpenSession={openSession} />
          </div>
        )
      )}

      {switcherOpen && (
        <QuickSwitcher
          channels={state.channels}
          activeChannelId={state.activeChannelId}
          meId={me.id}
          commands={quickSwitcherCommands}
          onSelect={(channelId) => {
            selectChannel(channelId);
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

      {spawnOpen && active && (
        <SpawnDialog
          key={`spawn:${spawnInitialTask}`}
          channelName={
            active.kind === 'dm' || active.kind === 'gdm'
              ? channelLabel(active, me.id)
              : `${active.kind === 'private' ? '' : '#'}${active.name}`
          }
          initialTask={spawnInitialTask}
          onCancel={() => {
            setSpawnOpen(false);
            setSpawnInitialTask('');
          }}
          onSpawn={startConfiguredSession}
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
            setMainSurface('chat');
            selectChannel(channelId);
            void openThreadInChannel(channelId, threadRootEventId).catch(onApiError);
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
