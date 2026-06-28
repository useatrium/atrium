import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type Channel,
  type Workspace,
} from './api';
import { isDesktop, desktopWsUrl } from './desktop';
import {
  DurableOpQueue,
  appReducer,
  createDefaultOpRegistry,
  queuedChangesLabel,
  dispatchSyncSnapshot,
  dispatchSyncResponse,
  initialAppState,
  looksLikeAgentCommand,
  mentionsHandle,
  parseAgentTask,
  randomId,
  type AttachmentRef,
  type EnqueueOpInput,
  type MsgSendPayload,
  type OpQueueLockProvider,
  type OpType,
  type ReactionSetPayload,
  type SessionSpawnPayload,
  type UploadPayload,
  type VoiceMeta,
  useQueuedChangesCount,
} from '@atrium/surface-client';
import { showNotification } from './notify';
import {
  type CallWire,
  emptyTimeline,
  type AttachmentMeta,
  type ChatMessage,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';
import { useWs } from '@atrium/surface-client';
import { Avatar } from './components/Avatar';
import { CallNotice, InCallPanel, IncomingCallBanner } from './components/CallUI';
import { ClaudeConnectDialog } from './components/ClaudeConnectDialog';
import { CodexConnectDialog } from './components/CodexConnectDialog';
import { Composer } from './components/Composer';
import { LockIcon, PhoneIcon, PlusIcon, SearchIcon, XIcon } from './components/icons';
import { showErrorToast } from './components/Toasts';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';
import { sessionsApi } from './sessions/api';
import { sessionsMockBus } from './sessions/devMock';
import { SessionPane } from './sessions/SessionPane';
import { SessionsRail } from './sessions/SessionsRail';
import { SpawnDialog, type SpawnConfig } from './sessions/SpawnDialog';
import { ViewToggle, type SessionView } from './sessions/ViewToggle';
import {
  PENDING_SESSION_PREFIX,
  isPendingSessionId,
  isTerminalSessionStatus,
  sessionFromWire,
  type Session,
} from './sessions/types';
import { adoptPrefs } from './theme';
import { channelAvatarName, channelLabel, dmPartner } from '@atrium/surface-client';
import { useDialog } from './useDialog';
import { clearCache, eventCache } from './cacheIdb';
import { hydrateCachedTimelines } from './hydration';
import { useAgentProfiles } from './useAgentProfiles';
import { useCall } from './useCall';
import { useCallsAvailable } from './useCallsAvailable';
import { useDraftState } from './useDraftState';
import { useProviderCredentials } from './useProviderCredentials';
import { useTypingIndicators } from './useTypingIndicators';

const PAGE_SIZE = 50;
const SYNC_LIMIT = 500;
const NO_WATCHERS: UserRef[] = [];
const QUEUE_NUDGE_KEY = 'atrium:queue-nudge';
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
const browserWsUrl = import.meta.env.VITE_ATRIUM_WS_URL?.trim();

type VoiceSendMeta = Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>;
type VoiceMsgSendPayload = MsgSendPayload & {
  voice?: Pick<VoiceMeta, 'durationMs' | 'waveform'>;
};
type EnqueueOpOptions = {
  onStored?: () => void;
};

function fallbackUser(id: string): UserRef {
  return { id, handle: id, displayName: id };
}

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
    : false;
}

function userForCall(call: CallWire, channels: Channel[], userId: string): UserRef {
  return (
    call.participants.find((u) => u.id === userId) ??
    channels
      .find((c) => c.id === call.channelId)
      ?.members?.find((u) => u.id === userId) ??
    fallbackUser(userId)
  );
}

function labelForCallChannel(call: CallWire, channels: Channel[], meId: string): string {
  const channel = channels.find((c) => c.id === call.channelId);
  if (!channel) return 'Unknown channel';
  return channel.kind === 'private' ? `#${channel.name}` : channelLabel(channel, meId);
}

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
    window.localStorage.setItem(QUEUE_NUDGE_KEY, `${Date.now()}:${Math.random()}`);
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
  const calls = useCall(me, state.channels);
  const callsAvailable = useCallsAvailable();
  const stateRef = useRef(state);
  stateRef.current = state;
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

  const opRegistry = useMemo(() => {
    const registry = createDefaultOpRegistry();
    const baseSend = registry['msg.send'];
    registry['msg.send'] = {
      ...baseSend,
      execute: async (apiClient, payload, op, context) => {
        const voicePayload = (payload as VoiceMsgSendPayload).voice;
        let attachments = payload.attachments?.map((a) => a.id);
        if (payload.attachmentRefs && payload.attachmentRefs.length > 0) {
          const ops = await context.listOps();
          attachments = payload.attachmentRefs.map((ref) => {
            const uploadOp = ops.find((candidate) => candidate.queueKey === `upload:${ref.uploadKey}`);
            const uploadPayload = uploadOp?.payload as Partial<UploadPayload> | undefined;
            if (uploadOp?.status !== 'completed' || !uploadPayload?.uploaded || !uploadPayload.fileId) {
              throw new TypeError(`upload ${ref.uploadKey} is not ready`);
            }
            return uploadPayload.fileId;
          });
        }
        return apiClient.postMessage({
          channelId: payload.channelId,
          text: payload.text,
          clientMsgId: payload.clientMsgId,
          threadRootEventId: payload.threadRootEventId,
          attachments,
          ...(voicePayload ? { voice: voicePayload } : {}),
          opId: op.opId,
        });
      },
    };
    return registry;
  }, []);

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
    [cacheMute, onApiError, opRegistry, queueDispatch, queuedFailureMessage],
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
    (msg: MsgSendPayload): ChatMessage => {
      const voice = (msg as VoiceMsgSendPayload).voice;
      const voiceFileId = msg.attachments?.[0]?.id;
      return {
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
        ...(voice && voiceFileId
          ? {
              voice: {
                fileId: voiceFileId,
                durationMs: voice.durationMs,
                ...(voice.waveform ? { waveform: voice.waveform } : {}),
                transcript: { status: 'pending' },
              },
            }
          : {}),
      };
    },
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
          harness: payload.harness ?? 'codex',
          repo: payload.repo ?? null,
          branch: payload.branch ?? null,
          spawnedBy: me.id,
          spawnerName: me.displayName,
          driverId: null,
          pendingSeatRequests: [],
          suggestions: [],
          answerProposals: [],
          providerAuthRequired: null,
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

  // Layout-grammar focus flag (see the derived `view` below). Kept up here so the
  // permalink effect can set it; the invariant is `focused` ⇒ a session is open.
  const [focused, setFocused] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(isMobileViewportNow);
  // Configured-spawn dialog (the @agent composer grammar is the quick path).
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [demoStarting, setDemoStarting] = useState(false);
  const agentProfiles = useAgentProfiles();
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

  const active = state.channels.find((c) => c.id === state.activeChannelId) ?? null;
  const timeline = (active && state.timelines[active.id]) || emptyTimeline;
  const openThreadRoot =
    state.openThreadRootId != null
      ? timeline.main.find((m) => m.id === state.openThreadRootId) ?? null
      : null;
  const threadReplies =
    state.openThreadRootId != null ? timeline.threads[state.openThreadRootId] ?? [] : [];
  const threadLoaded =
    state.openThreadRootId != null && timeline.threads[state.openThreadRootId] !== undefined;
  const activeDraftKey = active ? `channel:${active.id}` : '';
  const threadDraftKey =
    active && openThreadRoot?.id != null ? `channel:${active.id}:thread:${openThreadRoot.id}` : '';
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
        reconcileDraftsFromSnapshot(
          response.state.drafts ?? {},
          response.state.draftDeletions ?? {},
        );
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
      reconcileDraftsFromSnapshot(
        response.state.drafts ?? {},
        response.state.draftDeletions ?? {},
      );
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

  const { clearTypingUser, onSessionTyping, onTyping, sessionTyping, typing } =
    useTypingIndicators({
      activeChannelId: state.activeChannelId,
      meId: me.id,
    });

  const ws = useWs(
    hydrated,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
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
    // Desktop shell: connect to the absolute server origin with a bearer token
    // in the query string. E2E may pass a direct browser WS URL to avoid the
    // Vite proxy; normal browsers keep same-origin /ws.
    isDesktop
      ? { url: () => desktopWsUrl() ?? '' }
      : browserWsUrl
        ? { url: browserWsUrl }
        : undefined,
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

  // ---- thread panel ----
  const openThread = (rootEventId: number) => {
    if (!active) return;
    dispatch({ type: 'open-thread', rootEventId });
    const channelId = active.id;
    api
      .thread(rootEventId)
      .then(({ events }) => dispatch({ type: 'thread-loaded', channelId, rootEventId, events }));
  };

  // ---- session pane + layout grammar (channel / split / focus) ----
  // `focused` (declared above) is the only extra bit of layout state; the view
  // is derived. A permalink (/s/:id) lands in Focus; a card click opens a peek.
  const view: SessionView = state.openSessionId ? (focused ? 'focus' : 'split') : 'channel';

  // Closing the pane (X, Esc, channel switch, not-found) always resets focus so
  // the next open starts as a peek.
  useEffect(() => {
    if (!state.openSessionId) setFocused(false);
  }, [state.openSessionId]);

  const setView = useCallback(
    (next: SessionView) => {
      if (next === 'channel') dispatch({ type: 'close-session' });
      else if (stateRef.current.openSessionId) setFocused(next === 'focus');
    },
    [],
  );

  const openSession = (sessionId: string) => {
    if (isPendingSessionId(sessionId)) return;
    setFocused(false); // a fresh open is a peek, even when arriving from another focused session
    dispatch({ type: 'open-session', sessionId });
    sessionsApi
      .get(sessionId)
      .then(({ session }) => dispatch({ type: 'session-upsert', session: sessionFromWire(session) }))
      // Without this the pane sits on "Loading session…" forever on failure;
      // session-load-failed flips it to the recoverable not-found state.
      .catch(() => dispatch({ type: 'session-load-failed', sessionId }));
  };

  const paneSession = state.openSessionId ? state.sessions[state.openSessionId] ?? null : null;
  // The Sessions rail (channel view's right slot) appears only once the channel
  // has at least one session — progressive disclosure, not chrome by default.
  const hasChannelSessions = useMemo(
    () =>
      active != null && Object.values(state.sessions).some((s) => s.channelId === active.id),
    [active, state.sessions],
  );
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
    opts?: {
      harness?: string;
      repo?: string;
      branch?: string;
      agentProfileId?: string;
      agentProfileVersionId?: string;
    },
  ) => {
    const harness = opts?.harness?.trim() || 'codex';
    const clientSpawnId = `${PENDING_SESSION_PREFIX}${randomId()}`;
    const payload: SessionSpawnPayload = {
      channelId,
      task,
      clientSpawnId,
      threadRootEventId,
      harness,
      ...(opts?.repo?.trim() ? { repo: opts.repo.trim() } : {}),
      ...(opts?.branch?.trim() ? { branch: opts.branch.trim() } : {}),
      ...(opts?.agentProfileId ? { agentProfileId: opts.agentProfileId } : {}),
      ...(opts?.agentProfileVersionId ? { agentProfileVersionId: opts.agentProfileVersionId } : {}),
      createdAt: new Date().toISOString(),
    };
    const pending = pendingSpawnFromPayload(payload);
    void enqueueOp(
      {
        opId: randomId(),
        opType: 'session.spawn',
        payload,
      },
      {
        onStored: () =>
          dispatch({
            type: 'session-spawn-pending',
            channelId,
            message: pending.message,
            session: pending.session,
          }),
      },
    ).catch(() => {
      dispatch({ type: 'session-spawn-failed', channelId, tempId: clientSpawnId });
      showErrorToast("Couldn't queue the agent session.");
    });
  };

  // From the spawn dialog: a configured spawn into the channel the dialog is
  // showing (bind to render-time `active`, not the ref, so display and target
  // can't diverge), then open the new session as a peek.
  const startConfiguredSession = (config: SpawnConfig) => {
    if (!active) return;
    setSpawnOpen(false);
    spawnQueuedSession(active.id, config.task, undefined, {
      harness: config.harness,
      ...(config.repo ? { repo: config.repo } : {}),
      ...(config.branch ? { branch: config.branch } : {}),
      ...(config.agentProfileId ? { agentProfileId: config.agentProfileId } : {}),
      ...(config.agentProfileVersionId ? { agentProfileVersionId: config.agentProfileVersionId } : {}),
    });
  };

  const send = (
    channelId: string,
    text: string,
    threadRootEventId?: number,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: VoiceSendMeta,
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
      ...(voice
        ? {
            voice: {
              fileId: voice.fileId,
              durationMs: voice.durationMs,
              ...(voice.waveform ? { waveform: voice.waveform } : {}),
              transcript: { status: 'pending' },
            },
          }
        : {}),
    };
    const payload: VoiceMsgSendPayload = {
      channelId,
      text,
      clientMsgId,
      threadRootEventId,
      attachments,
      attachmentRefs,
      createdAt,
      ...(voice
        ? { voice: { durationMs: voice.durationMs, ...(voice.waveform ? { waveform: voice.waveform } : {}) } }
        : {}),
    };
    void enqueueOp(
      {
        opId: randomId(),
        opType: 'msg.send',
        payload: payload as MsgSendPayload,
      },
      {
        onStored: () => dispatch({ type: 'send-pending', channelId, message }),
      },
    ).catch(() => {
      dispatch({ type: 'send-failed', channelId, clientMsgId });
      showErrorToast("Couldn't queue the message.");
    });
  };

  const editMessage = async (m: ChatMessage, text: string): Promise<void> => {
    if (m.id == null) return;
    const eventId = m.id;
    const opId = randomId();
    try {
      await enqueueOp(
        {
          opId,
          opType: 'msg.edit',
          payload: { channelId: m.channelId, eventId, text },
        },
        {
          onStored: () =>
            dispatch({
              type: 'edit-overlay-pending',
              channelId: m.channelId,
              opId,
              targetEventId: eventId,
              text,
            }),
        },
      );
    } catch {
      dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
      showErrorToast("Couldn't queue the edit.");
    }
  };

  const removeMessage = async (m: ChatMessage): Promise<void> => {
    if (m.id == null) return;
    const eventId = m.id;
    const opId = randomId();
    try {
      await enqueueOp(
        {
          opId,
          opType: 'msg.delete',
          payload: { channelId: m.channelId, eventId },
        },
        {
          onStored: () =>
            dispatch({
              type: 'delete-overlay-pending',
              channelId: m.channelId,
              opId,
              targetEventId: eventId,
            }),
        },
      );
    } catch {
      dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
      showErrorToast("Couldn't queue the delete.");
    }
  };

  const reactToMessage = async (m: ChatMessage, emoji: string): Promise<void> => {
    if (m.id == null) return;
    const eventId = m.id;
    const mine = m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(me.id) === true;
    const action = mine ? 'remove' : 'add';
    const opId = randomId();
    const payload: ReactionSetPayload = {
      channelId: m.channelId,
      eventId,
      emoji,
      action,
      userId: me.id,
    };
    try {
      await enqueueOp(
        { opId, opType: 'reaction.set', payload },
        {
          onStored: () =>
            dispatch({
              type: 'reaction-overlay-pending',
              channelId: m.channelId,
              opId,
              targetEventId: eventId,
              emoji,
              userId: me.id,
              action,
            }),
        },
      );
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
    send(
      m.channelId,
      m.text,
      m.threadRootEventId ?? undefined,
      m.attachments,
      undefined,
      m.voice
        ? { fileId: m.voice.fileId, durationMs: m.voice.durationMs, waveform: m.voice.waveform }
        : undefined,
    );
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
      if (isSidebarOpen) {
        setIsSidebarOpen(false);
        return;
      }
      const s = stateRef.current;
      if (s.openSessionId) dispatch({ type: 'close-session' });
      else if (s.openThreadRootId != null) dispatch({ type: 'close-thread' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSidebarOpen, switcherOpen]);

  // ---- unread badge in the tab title ----
  const unreadCount = Object.values(state.unread).filter(Boolean).length;
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Atrium` : 'Atrium';
    return () => {
      document.title = 'Atrium';
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

  const queueStatusText = queuedChangesLabel(state.wsStatus, queuedChangesCount);
  const incomingCaller = calls.incomingCall
    ? userForCall(calls.incomingCall, state.channels, calls.incomingCall.initiatorId)
    : null;
  const incomingChannelName = calls.incomingCall
    ? labelForCallChannel(calls.incomingCall, state.channels, me.id)
    : '';
  const activeCallChannelName = calls.activeCall
    ? labelForCallChannel(calls.activeCall.call, state.channels, me.id)
    : '';
  const sessionPaneLayout: SessionView = isMobileViewport ? 'focus' : focused ? 'focus' : 'split';

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={state.activeChannelId}
        unread={state.unread}
        me={me}
        wsStatus={state.wsStatus}
        onSelect={(channelId) => {
          selectChannel(channelId);
          setIsSidebarOpen(false);
        }}
        onSetMute={setMute}
        onCreateChannel={createChannel}
        onStartDm={startDm}
        onOpenSession={(sessionId) => {
          openSession(sessionId);
          setIsSidebarOpen(false);
        }}
        sessionEventSeq={sessionEventSeq}
        providerCredentials={providerCredentials}
        onConnectProvider={setProviderDialog}
        onLogout={onLogout}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />

      {view !== 'focus' && (
        <main
          className={`${state.openSessionId ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col`}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2 md:gap-3 md:px-4">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open navigation"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-raised/40 text-fg-muted hover:bg-surface-overlay hover:text-fg-body md:hidden"
            >
              <span className="flex flex-col gap-1" aria-hidden="true">
                <span className="block h-px w-4 bg-current" />
                <span className="block h-px w-4 bg-current" />
                <span className="block h-px w-4 bg-current" />
              </span>
            </button>
            <h1 className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-bold text-fg md:flex-none">
            {active?.kind === 'dm' || active?.kind === 'gdm' ? (
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
            onClick={() => setSpawnOpen(true)}
            disabled={!active}
            title="New agent"
            aria-label="New agent"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted md:ml-auto"
          >
            <PlusIcon size={14} />
            <span className="hidden sm:inline">New agent</span>
          </button>
          {state.openSessionId && (
            <div className="hidden md:flex">
              <ViewToggle view={view} hasSession onSetView={setView} />
            </div>
          )}
          {/* Calls unconfigured: keep the phone visible but grayed with a setup
              hint (tooltip + click), so the feature is discoverable instead of
              hidden — rather than a dead button that fails on click. */}
          <button
            onClick={() => {
              if (!callsAvailable) {
                showErrorToast(
                  'Voice calls aren’t set up. Configure LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) to enable calls.',
                );
                return;
              }
              if (active) void calls.startCall(active.id);
            }}
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
                ? 'rounded-md border border-edge bg-surface-raised/40 px-2 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:cursor-default disabled:text-fg-faint'
                : 'rounded-md border border-edge bg-surface-raised/20 px-2 py-1 text-fg-faint cursor-help hover:text-fg-muted'
            }
          >
            <PhoneIcon size={15} />
          </button>
          <button
            onClick={() => setSwitcherOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-raised/40 px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
          >
            <SearchIcon size={14} />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-edge px-1 py-px text-3xs font-medium text-fg-muted lg:inline">
              ⌘K
            </kbd>
          </button>
          {presentUsers.length > 0 && (
            <div
              className="hidden items-center gap-2 md:flex"
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

        {calls.notice && <CallNotice message={calls.notice} onDismiss={calls.clearNotice} />}
        {calls.incomingCall && incomingCaller && (
          <IncomingCallBanner
            call={calls.incomingCall}
            caller={incomingCaller}
            channelName={incomingChannelName}
            answering={calls.answering}
            onAccept={() => void calls.acceptIncomingCall()}
            onDecline={() => void calls.declineIncomingCall()}
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
          unreadDividerAfterId={unreadDividerAfterId}
        />

        {active && !state.openSessionId && (
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
              autoFocus
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
          onToggleFocus={() => setFocused((f) => !f)}
          watchers={paneWatchers}
          typers={Object.values(sessionTyping[paneSession.id] ?? {}).map((t) => t.user)}
          onComposerTyping={() => notifySessionTyping(paneSession.id)}
          onClose={() => dispatch({ type: 'close-session' })}
          onAnswerQuestion={answerSessionQuestion}
          onSteer={steerSession}
          failedSteer={failedSteers[paneSession.id] ?? null}
          onClearFailedSteer={() => clearFailedSteer(paneSession.id)}
          onCancelSession={cancelSession}
          failedCancel={failedCancels[paneSession.id] === true}
          onClearFailedCancel={() => clearFailedCancel(paneSession.id)}
          providerCredentials={providerCredentials}
          onConnectProvider={setProviderDialog}
        />
      ) : state.openSessionId ? (
        <aside
          className={`flex min-w-0 flex-col border-l border-edge bg-surface/60 ${
            isMobileViewport || focused ? 'flex-1' : 'w-[min(520px,42vw)] shrink-0'
          }`}
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
      ) : openThreadRoot && active ? (
        <div className="hidden md:contents">
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
            draftKey={threadDraftKey}
            initialDraft={drafts[threadDraftKey] ?? ''}
            onDraftChange={saveDraft}
            onDraftPersisted={enqueueDraft}
            onDraftTouched={markDraftTouched}
          />
        </div>
      ) : (
        active &&
        hasChannelSessions && (
          <div className="hidden md:contents">
            <SessionsRail
              channelId={active.id}
              sessions={state.sessions}
              onOpenSession={openSession}
            />
          </div>
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
          onOpenSession={(sessionId) => {
            openSession(sessionId);
            setSwitcherOpen(false);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {spawnOpen && active && (
        <SpawnDialog
          channelName={
            active.kind === 'dm' || active.kind === 'gdm'
              ? channelLabel(active, me.id)
              : `${active.kind === 'private' ? '' : '#'}${active.name}`
          }
          onCancel={() => setSpawnOpen(false)}
          onSpawn={startConfiguredSession}
          providerStatuses={providerCredentials}
          profiles={agentProfiles}
          onConnectProvider={setProviderDialog}
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
