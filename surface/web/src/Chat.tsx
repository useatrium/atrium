import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import {
  DurableOpQueue,
  appReducer,
  queuedChangesLabel,
  dispatchSyncSnapshot,
  dispatchSyncResponse,
  initialAppState,
  looksLikeAgentCommand,
  mentionsHandle,
  parseAgentTask,
  randomId,
  reconcileDraftSnapshot,
  type AttachmentRef,
  type DraftSnapshot,
  type EnqueueOpInput,
  type MsgSendPayload,
  type OpQueueLockProvider,
  type OpType,
  type ReactionSetPayload,
  type SessionSpawnPayload,
  type UploadPayload,
  useQueuedChangesCount,
} from '@atrium/surface-client';
import { showNotification } from './notify';
import {
  emptyTimeline,
  type AttachmentMeta,
  type ChatMessage,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';
import { useWs } from '@atrium/surface-client';
import { Avatar } from './components/Avatar';
import { Composer } from './components/Composer';
import { LockIcon, SearchIcon, XIcon } from './components/icons';
import { showErrorToast } from './components/Toasts';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';
import { sessionsApi } from './sessions/api';
import { sessionsMockBus } from './sessions/devMock';
import { SessionPane } from './sessions/SessionPane';
import {
  PENDING_SESSION_PREFIX,
  isPendingSessionId,
  isTerminalSessionStatus,
  sessionFromWire,
  type Session,
} from './sessions/types';
import { adoptPrefs } from './theme';
import { channelLabel, dmPartner } from '@atrium/surface-client';
import { useDialog } from './useDialog';
import { clearCache, eventCache } from './cacheIdb';
import { hydrateCachedTimelines } from './hydration';

const PAGE_SIZE = 50;
const SYNC_LIMIT = 500;
const NO_WATCHERS: UserRef[] = [];
const QUEUE_NUDGE_KEY = 'atrium:queue-nudge';

function createQueueLockProvider(): OpQueueLockProvider | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const locks = (
    navigator as Navigator & {
      locks?: {
        request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T>;
      };
    }
  ).locks;
  if (!locks) return undefined;
  return {
    request: <T,>(name: string, callback: () => Promise<T>) => locks.request<T>(name, callback),
  };
}

function broadcastQueueNudge(): void {
  try {
    localStorage.setItem(QUEUE_NUDGE_KEY, `${Date.now()}:${Math.random()}`);
  } catch {
    // Best-effort multi-tab wake-up only.
  }
}

export function Chat({
  me,
  workspace,
  initialSessionId,
  onLogout,
}: {
  me: UserRef;
  workspace: Workspace;
  /** From the /s/:id permalink route — open this session's pane on load. */
  initialSessionId?: string | null;
  onLogout: () => void;
}) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [sessionEventSeq, setSessionEventSeq] = useState(0);
  const [failedSteers, setFailedSteers] = useState<Record<string, string>>({});
  const [failedCancels, setFailedCancels] = useState<Record<string, true>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const stateRef = useRef(state);
  stateRef.current = state;
  const touchedDraftKeysRef = useRef<Set<string>>(new Set());
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
    const channels = stateRef.current.channels.map((c) =>
      c.id === channelId ? { ...c, muted } : c,
    );
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

  const onApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) invalidateAuth();
    },
    [invalidateAuth],
  );

  const queueDispatch = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      dispatch(action);
      if (action.type === 'server-event') {
        if (action.event.type.startsWith('session.')) setSessionEventSeq((n) => n + 1);
        if (action.event.channelId) eventCache.enqueueEvents(action.event.channelId, [action.event]);
        cacheSyncCursor(action.event.id);
      }
      if (action.type === 'sync-cursor') cacheSyncCursor(action.cursor);
      if (action.type === 'mute-changed') cacheMute(action.channelId, action.muted);
    },
    [cacheMute, cacheSyncCursor],
  );

  const queuedFailureMessage = useCallback((opType: OpType): string => {
    switch (opType) {
      case 'msg.send':
        return "Couldn't send the message.";
      case 'upload':
        return "Couldn't upload the file.";
      case 'msg.edit':
        return "Couldn't save the edit.";
      case 'msg.delete':
        return "Couldn't delete the message.";
      case 'reaction.set':
        return "Couldn't update the reaction.";
      case 'read.mark':
        return "Couldn't mark the channel read.";
      case 'mute.set':
        return "Couldn't update the mute setting.";
      case 'session.spawn':
        return "Couldn't start the agent session.";
      case 'session.answer':
        return "Couldn't submit the answer.";
      case 'session.steer':
        return "Couldn't send the session message.";
      case 'session.cancel':
        return "Couldn't cancel the session.";
      case 'prefs.set':
        return "Couldn't sync settings.";
      case 'draft.set':
        return "Couldn't sync the draft.";
      case 'channel.join':
        return "Couldn't add the person.";
      case 'channel.leave':
        return "Couldn't leave the channel.";
    }
  }, []);

  const opQueue = useMemo(
    () =>
      new DurableOpQueue({
        storage: eventCache,
        api,
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
          if (op.opType === 'session.steer') {
            const payload = op.payload as { sessionId?: unknown; text?: unknown };
            if (typeof payload.sessionId === 'string' && typeof payload.text === 'string') {
              const sessionId = payload.sessionId;
              const text = payload.text;
              setFailedSteers((prev) => ({ ...prev, [sessionId]: text }));
            }
          }
          if (op.opType === 'session.cancel') {
            const payload = op.payload as { sessionId?: unknown };
            if (typeof payload.sessionId === 'string') {
              const sessionId = payload.sessionId;
              setFailedCancels((prev) => ({ ...prev, [sessionId]: true }));
            }
          }
          if (!(err instanceof ApiError && err.status === 401)) {
            showErrorToast(queuedFailureMessage(op.opType));
          }
        },
      }),
    [cacheMute, onApiError, queueDispatch, queuedFailureMessage],
  );

  const enqueueOp = useCallback(
    async <T extends OpType>(input: EnqueueOpInput<T>) => {
      const op = await opQueue.enqueue(input);
      if (op) {
        opQueue.nudge();
        markQueueNudged();
        broadcastQueueNudge();
      }
      return op;
    },
    [markQueueNudged, opQueue],
  );

  const activeDraftKeysForSync = useCallback((): ReadonlySet<string> => {
    const current = stateRef.current;
    const keys = new Set<string>();
    if (current.activeChannelId) {
      keys.add(`channel:${current.activeChannelId}`);
      if (current.openThreadRootId != null) {
        keys.add(`channel:${current.activeChannelId}:thread:${current.openThreadRootId}`);
      }
    }
    return keys;
  }, []);

  const reconcileDraftsFromSnapshot = useCallback(
    (snapshot: DraftSnapshot) => {
      void eventCache
        .listDrafts()
        .then(async (local) => {
          const { hydrate } = reconcileDraftSnapshot({
            snapshot,
            local,
            touchedThisSession: touchedDraftKeysRef.current,
            activeDraftKeys: activeDraftKeysForSync(),
          });
          const entries = Object.entries(hydrate);
          if (entries.length === 0) return;
          await Promise.all(
            entries.map(([draftKey, draft]) =>
              eventCache.setDraft(draftKey, draft.text, draft.updatedAt),
            ),
          );
          setDrafts((prev) => {
            let next = prev;
            for (const [draftKey, draft] of entries) {
              if (!(draftKey in prev) || prev[draftKey] === draft.text) continue;
              if (next === prev) next = { ...prev };
              next[draftKey] = draft.text;
            }
            return next;
          });
        })
        .catch((err: unknown) => {
          console.warn('failed to reconcile draft snapshot', err);
        });
    },
    [activeDraftKeysForSync],
  );

  const clearFailedSteer = useCallback((sessionId: string) => {
    setFailedSteers((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const steerSession = useCallback(
    async (sessionId: string, text: string): Promise<void> => {
      clearFailedSteer(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.steer',
        payload: { sessionId, text },
      });
    },
    [clearFailedSteer, enqueueOp],
  );

  const clearFailedCancel = useCallback((sessionId: string) => {
    setFailedCancels((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const cancelSession = useCallback(
    async (sessionId: string): Promise<void> => {
      clearFailedCancel(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.cancel',
        payload: { sessionId },
      });
    },
    [clearFailedCancel, enqueueOp],
  );

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

  const waitForUpload = useCallback(
    (uploadKey: string): Promise<{ fileId: string }> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          fn();
        };
        const check = () => {
          void eventCache
            .listOps()
            .then((ops) => {
              const op = ops.find((candidate) => candidate.queueKey === `upload:${uploadKey}`);
              if (!op) {
                finish(() => reject(new Error('upload was rejected')));
                return;
              }
              const payload = op.payload as Partial<UploadPayload>;
              if (op.status === 'completed' && payload.uploaded && payload.fileId) {
                finish(() => resolve({ fileId: payload.fileId! }));
              }
            })
            .catch((err: unknown) => finish(() => reject(err)));
        };
        const timer = setInterval(check, 250);
        check();
      }),
    [],
  );

  const queueUpload = useCallback(
    async (payload: UploadPayload): Promise<{ fileId: string }> => {
      await enqueueOp({
        opId: randomId(),
        opType: 'upload',
        payload,
      });
      return waitForUpload(payload.uploadKey);
    },
    [enqueueOp, waitForUpload],
  );

  const pendingMessageFromSendPayload = useCallback(
    (msg: MsgSendPayload): ChatMessage => ({
      id: null,
      clientMsgId: msg.clientMsgId,
      channelId: msg.channelId,
      threadRootEventId: msg.threadRootEventId ?? null,
      text: msg.text,
      edited: false,
      author: me,
      createdAt: msg.createdAt ?? new Date().toISOString(),
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    }),
    [me],
  );

  const pendingSpawnFromPayload = useCallback(
    (payload: SessionSpawnPayload): { message: ChatMessage; session: Session } => {
      const createdAt = payload.createdAt ?? new Date().toISOString();
      return {
        session: {
          id: payload.clientSpawnId,
          workspaceId: '',
          channelId: payload.channelId,
          threadRootEventId: payload.threadRootEventId ?? null,
          title: payload.task.slice(0, 80),
          status: 'spawning',
          harness: payload.harness ?? 'claude-code',
          spawnedBy: me.id,
          spawnerName: me.displayName,
          driverId: null,
          pendingSeatRequests: [],
          seatEvents: [],
          costUsd: 0,
          resultText: null,
          createdAt,
          completedAt: null,
          lastEventId: 0,
          permalink: '',
        },
        message: {
          id: null,
          clientMsgId: payload.clientSpawnId,
          channelId: payload.channelId,
          threadRootEventId: payload.threadRootEventId ?? null,
          text: payload.task,
          edited: false,
          author: me,
          createdAt,
          replyCount: 0,
          lastReplyId: 0,
          status: 'pending',
          sessionId: payload.clientSpawnId,
        },
      };
    },
    [me],
  );

  const applyQueuedOp = useCallback(
    (op: { opType: OpType; payload: unknown; opId: string }) => {
      if (op.opType === 'msg.send') {
        const payload = op.payload as MsgSendPayload;
        dispatch({
          type: 'send-pending',
          channelId: payload.channelId,
          message: pendingMessageFromSendPayload(payload),
        });
        return;
      }
      if (op.opType === 'session.spawn') {
        const payload = op.payload as SessionSpawnPayload;
        const pending = pendingSpawnFromPayload(payload);
        dispatch({
          type: 'session-spawn-pending',
          channelId: payload.channelId,
          message: pending.message,
          session: pending.session,
        });
        return;
      }
      if (op.opType === 'msg.edit') {
        const payload = op.payload as { channelId: string; eventId: number; text: string };
        dispatch({
          type: 'edit-overlay-pending',
          channelId: payload.channelId,
          opId: op.opId,
          targetEventId: payload.eventId,
          text: payload.text,
        });
        return;
      }
      if (op.opType === 'msg.delete') {
        const payload = op.payload as { channelId: string; eventId: number };
        dispatch({
          type: 'delete-overlay-pending',
          channelId: payload.channelId,
          opId: op.opId,
          targetEventId: payload.eventId,
        });
        return;
      }
      if (op.opType === 'reaction.set') {
        const payload = op.payload as ReactionSetPayload;
        dispatch({
          type: 'reaction-overlay-pending',
          channelId: payload.channelId,
          opId: op.opId,
          targetEventId: payload.eventId,
          emoji: payload.emoji,
          userId: payload.userId,
          action: payload.action,
        });
        return;
      }
      if (op.opType === 'mute.set') {
        const payload = op.payload as { channelId: string; muted: boolean };
        dispatch({ type: 'mute-changed', channelId: payload.channelId, muted: payload.muted });
        return;
      }
      if (op.opType === 'read.mark') {
        const payload = op.payload as { channelId: string; lastReadEventId: number };
        lastReadSentRef.current[payload.channelId] = Math.max(
          lastReadSentRef.current[payload.channelId] ?? 0,
          payload.lastReadEventId,
        );
        dispatch({
          type: 'read-cursor',
          channelId: payload.channelId,
          lastReadEventId: payload.lastReadEventId,
        });
      }
    },
    [pendingMessageFromSendPayload, pendingSpawnFromPayload],
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
            void eventCache.saveTimeline(channelId, latest.events, latest.hasMore).catch(
              (err: unknown) => {
                console.warn('failed to cache repaired hydrate history', err);
              },
            );
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

  // ---- permalink (/s/:id): load the session, jump to its channel, open pane ----
  useEffect(() => {
    if (!initialSessionId) return;
    dispatch({ type: 'open-session', sessionId: initialSessionId });
    sessionsApi
      .get(initialSessionId)
      .then(({ session }) => {
        dispatch({ type: 'session-upsert', session: sessionFromWire(session) });
        if (session.channelId) selectChannel(session.channelId);
        dispatch({ type: 'open-session', sessionId: session.id });
      })
      .catch(() => dispatch({ type: 'session-load-failed', sessionId: initialSessionId }));
  }, [initialSessionId, selectChannel]);

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
        .then(({ session: wire }) =>
          dispatch({ type: 'session-upsert', session: sessionFromWire(wire) }),
        )
        .catch(() => {}); // unreachable server — the stalled display covers it
    }
  }, [state.sessions]);

  // Keep the URL in sync with the open pane so it is copyable as a permalink.
  useEffect(() => {
    const path =
      state.openSessionId && !isPendingSessionId(state.openSessionId)
        ? `/s/${state.openSessionId}`
        : '/';
    if (location.pathname !== path) history.replaceState(null, '', path);
  }, [state.openSessionId]);

  // ---- DEV MOCK (sessions): fold synthetic session.* events; no-op without
  // VITE_SESSIONS_MOCK=1. Delete with src/sessions/devMock.ts. ----
  useEffect(
    () => sessionsMockBus?.subscribe((event: WireEvent) => dispatch({ type: 'server-event', event })),
    [],
  );

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
        void eventCache.saveTimeline(channelId, latest.events, latest.hasMore).catch(
          (err: unknown) => {
            console.warn('failed to cache sync repair history', err);
          },
        );
      }),
    );
  }, []);

  const syncFromCursor = useCallback(async () => {
    let cursor = stateRef.current.syncCursor;
    for (;;) {
      const response = await api.sync(cursor, { limit: SYNC_LIMIT });
      if (response.limited) {
        dispatchSyncSnapshot(dispatch, response.state, adoptPrefs);
        reconcileDraftsFromSnapshot(response.state.drafts ?? {});
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
      reconcileDraftsFromSnapshot(response.state.drafts ?? {});
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
      .then(flushQueuedOps)
      .catch(onApiError);
  }, [flushQueuedOps, onApiError, runReconnectSync]);

  useEffect(() => {
    if (hydrated) syncThenFlushQueuedOps();
  }, [hydrated, syncThenFlushQueuedOps]);

  // ---- typing indicators (ephemeral, per viewed channel) ----
  const [typing, setTyping] = useState<Record<string, { user: UserRef; until: number }>>({});
  const onTyping = useCallback(
    (channelId: string, user: UserRef) => {
      if (user.id === me.id || channelId !== stateRef.current.activeChannelId) return;
      setTyping((prev) => ({ ...prev, [user.id]: { user, until: Date.now() + 4000 } }));
    },
    [me.id],
  );
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        const live = Object.entries(prev).filter(([, v]) => v.until > now);
        return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live);
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setTyping({}), [state.activeChannelId]);

  const ws = useWs(
    hydrated,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
        if (event.type.startsWith('session.')) setSessionEventSeq((n) => n + 1);
        // A message landing ends that author's "is typing…" immediately.
        if (event.type === 'message.posted' && event.actorId) {
          setTyping((prev) => {
            if (!prev[event.actorId!]) return prev;
            const next = { ...prev };
            delete next[event.actorId!];
            return next;
          });
        }
        maybeNotify(event);
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
        cacheSyncCursor(event.id);
      },
      onPresence: (channelId, users) => dispatch({ type: 'presence', channelId, users }),
      onTyping,
      onRead: (channelId, lastReadEventId) => {
        lastReadSentRef.current[channelId] = Math.max(
          lastReadSentRef.current[channelId] ?? 0,
          lastReadEventId,
        );
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
  );

  const lastTypingSentRef = useRef(0);
  const notifyTyping = (channelId: string) => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2500) return;
    lastTypingSentRef.current = now;
    ws.sendTyping(channelId);
  };

  // Desktop notifications: mentions of me, and my agent sessions finishing.
  // Live WS events only (catch-up misses land in badges instead).
  function maybeNotify(event: WireEvent) {
    if (event.type === 'message.posted' && event.actorId && event.actorId !== me.id) {
      const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
      const ch = stateRef.current.channels.find((c) => c.id === event.channelId);
      if (ch?.muted) return;
      const isDm = ch?.kind === 'dm' || ch?.kind === 'gdm';
      if (!isDm && !mentionsHandle(text, me.handle)) return;
      const author = event.author?.displayName ?? 'Someone';
      showNotification(
        isDm ? `${author} (direct message)` : `${author} mentioned you in #${ch?.name ?? 'a channel'}`,
        text.slice(0, 140),
        `evt-${event.id}`,
        () => {
          if (event.channelId) selectChannel(event.channelId);
        },
      );
      return;
    }
    if (event.type === 'session.completed') {
      const sessionId =
        typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : null;
      const session = sessionId ? stateRef.current.sessions[sessionId] : undefined;
      if (!session || session.spawnedBy !== me.id) return;
      const status = typeof event.payload?.status === 'string' ? event.payload.status : 'done';
      const excerpt =
        typeof event.payload?.resultExcerpt === 'string' ? event.payload.resultExcerpt : '';
      showNotification(
        `Agent session ${status}: ${session.title}`,
        excerpt.slice(0, 140),
        `evt-${event.id}`,
        () => {
          if (sessionId) dispatch({ type: 'open-session', sessionId });
        },
      );
    }
  }

  // ---- channel selection & history ----
  const active = state.channels.find((c) => c.id === state.activeChannelId) ?? null;
  const timeline = (active && state.timelines[active.id]) || emptyTimeline;

  const markRead = useCallback((channelId: string, lastEventId: number) => {
    if (lastEventId <= 0 || (lastReadSentRef.current[channelId] ?? 0) >= lastEventId) return;
    const fire = () => {
      const previous = lastReadSentRef.current[channelId] ?? 0;
      if (previous >= lastEventId) return;
      lastReadAtRef.current[channelId] = Date.now();
      lastReadSentRef.current[channelId] = lastEventId;
      dispatch({ type: 'read-cursor', channelId, lastReadEventId: lastEventId });
      void enqueueOp({
        opId: randomId(),
        opType: 'read.mark',
        payload: { channelId, lastReadEventId: lastEventId },
      }).catch((err: unknown) => {
          if (lastReadSentRef.current[channelId] === lastEventId) {
            lastReadSentRef.current[channelId] = previous;
          }
          onApiError(err);
        });
    };
    const elapsed = Date.now() - (lastReadAtRef.current[channelId] ?? 0);
    if (elapsed >= 2000) {
      fire();
      return;
    }
    if (readTimersRef.current[channelId]) clearTimeout(readTimersRef.current[channelId]);
    readTimersRef.current[channelId] = setTimeout(fire, 2000 - elapsed);
  }, [enqueueOp, onApiError]);

  useEffect(() => {
    if (active) markRead(active.id, timeline.lastEventId);
  }, [active?.id, markRead, timeline.lastEventId]);

  useEffect(
    () => () => {
      for (const timer of Object.values(readTimersRef.current)) clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    if (!active || state.timelines[active.id]?.loaded) return;
    const channelId = active.id;
    api
      .messages(channelId, { limit: PAGE_SIZE })
      .then(({ events, hasMore }) => {
        // Skip if we lost access (kicked from a private channel) while the
        // fetch was in flight — avoids a ghost timeline.
        if (!stateRef.current.channels.some((c) => c.id === channelId)) return;
        dispatch({ type: 'history-loaded', channelId, events, hasMore });
        void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
          console.warn('failed to cache history', err);
        });
      })
      .catch(onApiError);
  }, [active?.id, onApiError]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- thread panel ----
  const openThreadRoot =
    state.openThreadRootId != null
      ? timeline.main.find((m) => m.id === state.openThreadRootId) ?? null
      : null;
  const threadReplies =
    state.openThreadRootId != null ? timeline.threads[state.openThreadRootId] ?? [] : [];

  const openThread = (rootEventId: number) => {
    if (!active) return;
    dispatch({ type: 'open-thread', rootEventId });
    const channelId = active.id;
    api
      .thread(rootEventId)
      .then(({ events }) => dispatch({ type: 'thread-loaded', channelId, rootEventId, events }));
  };

  // ---- session pane ----
  const openSession = (sessionId: string) => {
    if (isPendingSessionId(sessionId)) return;
    dispatch({ type: 'open-session', sessionId });
    sessionsApi
      .get(sessionId)
      .then(({ session }) => dispatch({ type: 'session-upsert', session: sessionFromWire(session) }))
      // Without this the pane sits on "Loading session…" forever on failure;
      // session-load-failed flips it to the recoverable not-found state.
      .catch(() => dispatch({ type: 'session-load-failed', sessionId }));
  };

  const paneSession = state.openSessionId ? state.sessions[state.openSessionId] ?? null : null;
  // Watching presence for the open pane (drives seat take-vs-request UX).
  const paneWatchers = paneSession
    ? state.presence[`session:${paneSession.id}`] ?? NO_WATCHERS
    : NO_WATCHERS;

  // Spectator counts ride the existing presence map under `session:<id>` keys.
  const spectators = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, users] of Object.entries(state.presence)) {
      if (key.startsWith('session:')) out[key.slice('session:'.length)] = users.length;
    }
    return out;
  }, [state.presence]);

  // ---- sending ----
  const spawnQueuedSession = (
    channelId: string,
    task: string,
    threadRootEventId?: number,
  ) => {
    const clientSpawnId = `${PENDING_SESSION_PREFIX}${randomId()}`;
    const payload: SessionSpawnPayload = {
      channelId,
      task,
      clientSpawnId,
      threadRootEventId,
      harness: 'claude-code',
      createdAt: new Date().toISOString(),
    };
    const pending = pendingSpawnFromPayload(payload);
    dispatch({
      type: 'session-spawn-pending',
      channelId,
      message: pending.message,
      session: pending.session,
    });
    void enqueueOp({
      opId: randomId(),
      opType: 'session.spawn',
      payload,
    }).catch(() => {
      dispatch({ type: 'session-spawn-failed', channelId, tempId: clientSpawnId });
      showErrorToast("Couldn't queue the agent session.");
    });
  };

  const send = (
    channelId: string,
    text: string,
    threadRootEventId?: number,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
  ) => {
    // Attachments can't ride along on a spawn — "@agent …" with files attached
    // sends as a plain message instead of silently dropping them.
    const noAttachments = !attachments || attachments.length === 0;
    if (text && noAttachments) {
      const task = parseAgentTask(text);
      if (task != null) {
        spawnQueuedSession(channelId, task, threadRootEventId);
        return;
      }
      if (looksLikeAgentCommand(text.trim())) {
        showErrorToast('Type @agent followed by the task to run.');
        return;
      }
    }
    const clientMsgId = randomId();
    const createdAt = new Date().toISOString();
    const message: ChatMessage = {
      id: null,
      clientMsgId,
      channelId,
      threadRootEventId: threadRootEventId ?? null,
      text,
      edited: false,
      author: me,
      createdAt,
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    dispatch({ type: 'send-pending', channelId, message });
    const payload: MsgSendPayload = {
      channelId,
      text,
      clientMsgId,
      threadRootEventId,
      attachments,
      attachmentRefs,
      createdAt,
    };
    void enqueueOp({
      opId: randomId(),
      opType: 'msg.send',
      payload,
    }).catch(() => {
      dispatch({ type: 'send-failed', channelId, clientMsgId });
      showErrorToast("Couldn't queue the message.");
    });
  };

  const editMessage = async (m: ChatMessage, text: string): Promise<void> => {
    if (m.id == null) return;
    const opId = randomId();
    dispatch({
      type: 'edit-overlay-pending',
      channelId: m.channelId,
      opId,
      targetEventId: m.id,
      text,
    });
    try {
      await enqueueOp({
        opId,
        opType: 'msg.edit',
        payload: { channelId: m.channelId, eventId: m.id, text },
      });
    } catch {
      dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
      showErrorToast("Couldn't queue the edit.");
    }
  };

  const removeMessage = async (m: ChatMessage): Promise<void> => {
    if (m.id == null) return;
    const opId = randomId();
    dispatch({
      type: 'delete-overlay-pending',
      channelId: m.channelId,
      opId,
      targetEventId: m.id,
    });
    try {
      await enqueueOp({
        opId,
        opType: 'msg.delete',
        payload: { channelId: m.channelId, eventId: m.id },
      });
    } catch {
      dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
      showErrorToast("Couldn't queue the delete.");
    }
  };

  const reactToMessage = async (m: ChatMessage, emoji: string): Promise<void> => {
    if (m.id == null) return;
    const mine = m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(me.id) === true;
    const action = mine ? 'remove' : 'add';
    const opId = randomId();
    const payload: ReactionSetPayload = {
      channelId: m.channelId,
      eventId: m.id,
      emoji,
      action,
      userId: me.id,
    };
    dispatch({
      type: 'reaction-overlay-pending',
      channelId: m.channelId,
      opId,
      targetEventId: m.id,
      emoji,
      userId: me.id,
      action,
    });
    try {
      await enqueueOp({ opId, opType: 'reaction.set', payload });
    } catch {
      dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
      showErrorToast("Couldn't queue the reaction.");
    }
  };

  // ---- jump to a message from search: page history back until it's loaded ----
  const [highlightId, setHighlightId] = useState<number | null>(null);
  useEffect(() => {
    if (highlightId == null) return;
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId]);

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
      if (
        m.status === 'confirmed' &&
        m.id != null &&
        m.author.id === me.id &&
        m.sessionId == null &&
        !m.deleted
      ) {
        setEditRequestId(m.id);
        return;
      }
    }
  };

  const retry = (m: ChatMessage) => {
    if (!m.clientMsgId) return;
    dispatch({ type: 'retry-remove', channelId: m.channelId, clientMsgId: m.clientMsgId });
    if (m.sessionId != null) {
      // Failed spawn: re-run the @agent flow with the original task text.
      spawnQueuedSession(m.channelId, m.text, m.threadRootEventId ?? undefined);
      return;
    }
    send(m.channelId, m.text, m.threadRootEventId ?? undefined, m.attachments);
  };

  const createChannel = async (name: string, isPrivate = false) => {
    try {
      const { channel } = await api.createChannel(name, { private: isPrivate });
      dispatch({ type: 'channel-added', channel });
      selectChannel(channel.id);
    } catch (err) {
      showErrorToast("Couldn't create the channel — try again.");
      throw err;
    }
  };

  const startDm = (userIds: string[]) => {
    api
      .createDmWithUsers(userIds)
      .then(({ channel }) => {
        dispatch({ type: 'channel-added', channel });
        selectChannel(channel.id);
      })
      .catch(() => showErrorToast("Couldn't start the conversation — try again."));
  };

  const setMute = (channelId: string, muted: boolean) => {
    const previousMuted = stateRef.current.channels.find((c) => c.id === channelId)?.muted === true;
    dispatch({ type: 'mute-changed', channelId, muted });
    void enqueueOp({
      opId: randomId(),
      opType: 'mute.set',
      payload: { channelId, muted, previousMuted },
    }).catch(() => {
      dispatch({ type: 'mute-changed', channelId, muted: previousMuted });
      showErrorToast("Couldn't queue the mute change.");
    });
  };

  const answerSessionQuestion = async (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ): Promise<void> => {
    await enqueueOp({
      opId: randomId(),
      opType: 'session.answer',
      payload: { sessionId, questionId, answers },
    });
  };

  const presentUsers = active ? state.presence[active.id] ?? [] : [];
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<UserRef[] | null>(null);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [memberPeople, setMemberPeople] = useState<UserRef[] | null>(null);
  const membersButtonRef = useRef<HTMLButtonElement | null>(null);
  const membersPopoverRef = useRef<HTMLDivElement | null>(null);
  const addMemberButtonRef = useRef<HTMLButtonElement | null>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);

  const loadMembers = useCallback(() => {
    if (!active || (active.kind !== 'private' && active.kind !== 'gdm')) return;
    api
      .channelMembers(active.id)
      .then(({ members }) => setMembers(members))
      .catch(() => setMembers([]));
  }, [active?.id, active?.kind]);

  useEffect(() => {
    setMembers(null);
    setMembersOpen(false);
    setMemberPickerOpen(false);
    setLeaveAsk(false);
  }, [active?.id]);

  const closeMembers = useCallback(() => {
    setMembersOpen(false);
    setMemberPickerOpen(false);
    setLeaveAsk(false);
  }, []);

  useDialog({
    open: membersOpen,
    containerRef: membersPopoverRef,
    initialFocusRef: addMemberButtonRef,
    invokerRef: membersButtonRef,
    closeOnOutsidePointer: true,
    onClose: closeMembers,
  });

  useEffect(() => {
    if (!leaveAsk) return;
    const t = setTimeout(() => setLeaveAsk(false), 5000);
    return () => clearTimeout(t);
  }, [leaveAsk]);

  const inviteMember = (userId: string) => {
    if (!active) return;
    void enqueueOp({
      opId: randomId(),
      opType: 'channel.join',
      payload: { channelId: active.id, userId },
    })
      .then((op) => {
        if (!op) return;
        loadMembers();
        setMemberPickerOpen(false);
      })
      .catch(() => showErrorToast("Couldn't queue the invite."));
  };

  const leaveActive = () => {
    if (!active) return;
    if (!leaveAsk) {
      setLeaveAsk(true);
      return;
    }
    setLeaveAsk(false);
    void enqueueOp({
      opId: randomId(),
      opType: 'channel.leave',
      payload: { channelId: active.id, userId: me.id },
    }).catch(() => showErrorToast("Couldn't queue the channel leave."));
  };

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
      const s = stateRef.current;
      if (s.openSessionId) dispatch({ type: 'close-session' });
      else if (s.openThreadRootId != null) dispatch({ type: 'close-thread' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [switcherOpen]);

  // ---- unread badge in the tab title ----
  const unreadCount = Object.values(state.unread).filter(Boolean).length;
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Atrium` : 'Atrium';
    return () => {
      document.title = 'Atrium';
    };
  }, [unreadCount]);

  const threadLoaded =
    state.openThreadRootId != null && timeline.threads[state.openThreadRootId] !== undefined;
  const activeDraftKey = active ? `channel:${active.id}` : '';
  const threadDraftKey =
    active && openThreadRoot?.id != null ? `channel:${active.id}:thread:${openThreadRoot.id}` : '';

  const loadDraft = useCallback((key: string, label: string) => {
    let disposed = false;
    setDrafts((prev) => ({ ...prev, [key]: '' }));
    void eventCache
      .getDraft(key)
      .then((draft) => {
        if (!disposed) setDrafts((prev) => ({ ...prev, [key]: draft ?? '' }));
      })
      .catch((err: unknown) => {
        console.warn(`failed to load ${label} draft`, err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!activeDraftKey) return;
    return loadDraft(activeDraftKey, 'channel');
  }, [activeDraftKey, loadDraft]);

  useEffect(() => {
    if (!threadDraftKey) return;
    return loadDraft(threadDraftKey, 'thread');
  }, [loadDraft, threadDraftKey]);

  const saveDraft = useCallback((key: string, text: string) => eventCache.setDraft(key, text), []);

  const markDraftTouched = useCallback((key: string) => {
    touchedDraftKeysRef.current.add(key);
  }, []);

  const enqueueDraft = useCallback(
    (key: string, text: string) => {
      markDraftTouched(key);
      void enqueueOp({
        opId: randomId(),
        opType: 'draft.set',
        payload: { draftKey: key, text },
      }).catch((err: unknown) => {
        console.warn('failed to queue draft sync', err);
      });
    },
    [enqueueOp, markDraftTouched],
  );

  const queueStatusText = queuedChangesLabel(state.wsStatus, queuedChangesCount);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={state.activeChannelId}
        unread={state.unread}
        me={me}
        wsStatus={state.wsStatus}
        onSelect={selectChannel}
        onSetMute={setMute}
          onCreateChannel={createChannel}
          onStartDm={startDm}
          onOpenSession={openSession}
          sessionEventSeq={sessionEventSeq}
          onLogout={onLogout}
        />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge px-4">
          <h1 className="flex items-center gap-1.5 text-sm font-bold text-fg">
            {active?.kind === 'dm' || active?.kind === 'gdm' ? (
              <>
                <Avatar
                  name={channelLabel(active, me.id)}
                  seed={dmPartner(active, me.id)?.id ?? active.id}
                  size={18}
                />
                {channelLabel(active, me.id)}
              </>
            ) : (
              <>
                <span className="mr-0.5 text-fg-muted">
                  {active?.kind === 'private' ? <LockIcon size={14} /> : '#'}
                </span>
                {active?.name ?? '…'}
              </>
            )}
          </h1>
          {active && (active.kind === 'private' || active.kind === 'gdm') && (
            <div className="relative">
              <button
                ref={membersButtonRef}
                onClick={() => {
                  setMembersOpen((v) => !v);
                  if (!members) loadMembers();
                }}
                aria-expanded={membersOpen}
                aria-haspopup="dialog"
                aria-controls="members-popover"
                className="rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
              >
                Members
              </button>
              {membersOpen && (
                <div
                  ref={membersPopoverRef}
                  id="members-popover"
                  role="dialog"
                  aria-label="Channel members"
                  className="absolute left-0 top-8 z-20 w-64 rounded-md border border-edge-strong bg-surface-raised p-2 shadow-xl"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-xs font-semibold text-fg-secondary">Members</h2>
                    <button
                      ref={addMemberButtonRef}
                      onClick={() => {
                        setMemberPickerOpen((v) => !v);
                        if (!memberPeople) {
                          api.users().then(({ users }) => setMemberPeople(users)).catch(() => setMemberPeople([]));
                        }
                      }}
                      className="rounded px-2 py-0.5 text-xs text-fg-tertiary hover:bg-surface-overlay"
                    >
                      Add
                    </button>
                  </div>
                  {memberPickerOpen && (
                    <div className="mb-2 max-h-32 overflow-y-auto border-b border-edge pb-2">
                      {(memberPeople ?? []).filter((u) => !members?.some((m) => m.id === u.id)).map((u) => (
                        <button
                          key={u.id}
                          onClick={() => inviteMember(u.id)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-fg-secondary hover:bg-surface-overlay"
                        >
                          <Avatar name={u.displayName} seed={u.id} size={16} />
                          <span className="truncate">{u.displayName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <ul className="max-h-48 overflow-y-auto">
                    {(members ?? active.members ?? []).map((u) => (
                      <li key={u.id} className="flex items-center gap-2 px-2 py-1 text-xs text-fg-secondary">
                        <Avatar name={u.displayName} seed={u.id} size={16} />
                        <span className="truncate">{u.displayName}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={leaveActive}
                    aria-label={leaveAsk ? 'Confirm leave channel' : 'Leave channel'}
                    className={`mt-2 w-full rounded border px-2 py-1 text-xs ${
                      leaveAsk
                        ? 'border-danger-border-strong bg-danger-tint/60 font-medium text-danger-text-strong hover:bg-danger-surface/60'
                        : 'border-danger-border/60 text-danger-text hover:bg-danger-tint/40'
                    }`}
                  >
                    {leaveAsk ? 'Confirm leave' : 'Leave'}
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setSwitcherOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised/40 px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
          >
            <SearchIcon size={14} />
            <span>Search</span>
            <kbd className="rounded border border-edge px-1 py-px text-3xs font-medium text-fg-muted">
              ⌘K
            </kbd>
          </button>
          {presentUsers.length > 0 && (
            <div
              className="flex items-center gap-2"
              title="Viewing this channel right now"
            >
              <div className="flex -space-x-1.5">
                {presentUsers.slice(0, 8).map((u) => (
                  <div key={u.id} className="rounded-md ring-2 ring-surface">
                    <Avatar name={u.displayName} seed={u.id} size={20} />
                  </div>
                ))}
              </div>
              <span className="text-2xs tabular-nums text-fg-muted">
                {presentUsers.length} here
              </span>
            </div>
          )}
        </header>

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
          onRetry={retry}
          onEdit={editMessage}
          onDelete={removeMessage}
          onReact={reactToMessage}
          unreadDividerAfterId={unreadDividerAfterId}
        />

        {active && (
          <>
            <TypingLine typing={typing} />
            <Composer
              placeholder={
                active.kind === 'dm' || active.kind === 'gdm'
                  ? `Message ${channelLabel(active, me.id)}`
                  : `Message ${active.kind === 'private' ? '' : '#'}${active.name}`
              }
              onSend={(text, attachments, attachmentRefs) =>
                send(active.id, text, undefined, attachments, attachmentRefs)
              }
              queueUpload={queueUpload}
              onTyping={() => notifyTyping(active.id)}
              onArrowUpOnEmpty={editLastOwn}
              draftKey={activeDraftKey}
              initialDraft={drafts[activeDraftKey] ?? ''}
              onDraftChange={saveDraft}
              onDraftPersisted={enqueueDraft}
              onDraftTouched={markDraftTouched}
              autoFocus
              agentAware
              allowAttachments
            />
          </>
        )}
      </main>

      {paneSession ? (
        <SessionPane
          key={paneSession.id} // full reset (stream, seat anchors, tool state) per session
          session={paneSession}
          me={me}
          watchers={paneWatchers}
          onClose={() => dispatch({ type: 'close-session' })}
          onAnswerQuestion={answerSessionQuestion}
          onSteer={steerSession}
          failedSteer={failedSteers[paneSession.id] ?? null}
          onClearFailedSteer={() => clearFailedSteer(paneSession.id)}
          onCancelSession={cancelSession}
          failedCancel={failedCancels[paneSession.id] === true}
          onClearFailedCancel={() => clearFailedCancel(paneSession.id)}
        />
      ) : state.openSessionId ? (
        <aside className="flex w-[min(520px,42vw)] shrink-0 flex-col border-l border-edge bg-surface/60">
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
              <div className="text-xs text-fg-muted">
                It may have been removed, or the link is wrong.
              </div>
              <button
                onClick={() => dispatch({ type: 'close-session' })}
                className="mt-2 rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              Loading session…
            </div>
          )}
        </aside>
      ) : (
        openThreadRoot &&
        active && (
          <ThreadPanel
            root={openThreadRoot}
            replies={threadReplies}
            loaded={threadLoaded}
            sessions={state.sessions}
            spectators={spectators}
            meId={me.id}
            meHandle={me.handle}
            onClose={() => dispatch({ type: 'close-thread' })}
            onSend={(text, attachments, attachmentRefs) =>
              send(active.id, text, openThreadRoot.id!, attachments, attachmentRefs)
            }
            queueUpload={queueUpload}
            onOpenSession={openSession}
            onRetry={retry}
            onEdit={editMessage}
            onDelete={removeMessage}
            onReact={reactToMessage}
            draftKey={threadDraftKey}
            initialDraft={drafts[threadDraftKey] ?? ''}
            onDraftChange={saveDraft}
            onDraftPersisted={enqueueDraft}
            onDraftTouched={markDraftTouched}
          />
        )
      )}

      {switcherOpen && (
        <QuickSwitcher
          channels={state.channels}
          activeChannelId={state.activeChannelId}
          meId={me.id}
          onSelect={(channelId) => {
            selectChannel(channelId);
            setSwitcherOpen(false);
          }}
          onJumpToMessage={(event) => {
            setSwitcherOpen(false);
            void jumpToMessage(event);
          }}
          onClose={() => setSwitcherOpen(false)}
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
