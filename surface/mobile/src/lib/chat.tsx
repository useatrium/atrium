// App-wide chat store: the shared appReducer + WebSocket + API client, wired
// for native (absolute base URL, bearer token, ?token= on the WS upgrade).
// Mirrors web/src/Chat.tsx's glue so the two clients behave identically.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Alert, AppState as RNAppState, Linking } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import {
  ApiError,
  DEFAULT_PREFS,
  DurableOpQueue,
  FILES_CHANGED_EVENT_TYPE,
  appReducer,
  createDefaultOpRegistry,
  createApi,
  dispatchSyncSnapshot,
  dispatchSyncResponse,
  filesChangedWorkspaceId,
  initialAppState,
  isPendingSessionId,
  isTerminalSessionStatus,
  looksLikeAgentCommand,
  parseAgentTask,
  PENDING_SESSION_PREFIX,
  randomId,
  reconcileDraftSnapshot,
  sessionFromWire,
  useQueuedChangesCount,
  useWs,
  type Api,
  type AppState,
  type AttachmentRef,
  type AttachmentMeta,
  type Channel,
  type ChatMessage,
  type DraftDeletionSnapshot,
  type DraftSnapshot,
  type EnqueueOpInput,
  type MsgSendPayload,
  type OpType,
  type QueuedOp,
  type ReactionSetPayload,
  type SessionSpawnPayload,
  type Session as AgentSession,
  type UploadPayload,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';
import type { Artifact } from '@atrium/centaur-client';
import { useSession, type Session } from './session';
import { eventCache } from './cacheSqlite';
import {
  createArtifactContentResolver,
  createEntryResolver,
  type ArtifactContentResolver,
  type EntryResolver,
} from './entryResolve';
import { useTheme } from './theme';
import { useCall } from './useCall';
import type { VoiceSendMeta } from './voice';

const PAGE_SIZE = 50;
const SYNC_LIMIT = 500;

export interface TypingEntry {
  user: UserRef;
  until: number;
}

type SpawnSessionOptions = Pick<
  SessionSpawnPayload,
  | 'harness'
  | 'repo'
  | 'branch'
  | 'repos'
  | 'githubIdentityMode'
  | 'githubIdentityId'
  | 'agentProfileId'
  | 'agentProfileVersionId'
>;

interface ChatContextValue {
  state: AppState;
  me: UserRef;
  queuedChangesCount: number;
  serverUrl: string;
  api: Api;
  resolveEntry: EntryResolver;
  resolveArtifactContent: ArtifactContentResolver;
  calls: ReturnType<typeof useCall>;
  channelsLoaded: boolean;
  channelsError: string | null;
  refreshChannels: () => void;
  /** Channel screen came into focus: select it and load history. */
  openChannel: (channelId: string) => void;
  /** Channel screen lost focus: unreads accrue everywhere again. */
  leaveChannel: () => void;
  /** Advance a channel's read cursor after the viewer reaches the bottom. */
  markRead: (channelId: string, lastEventId: number) => void;
  loadEarlier: (channelId: string) => Promise<void>;
  openThread: (channelId: string, rootEventId: number) => void;
  retryThread: (channelId: string, rootEventId: number) => void;
  threadErrors: Record<number, string>;
  send: (
    channelId: string,
    text: string,
    threadRootEventId?: number,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: VoiceSendMeta,
    broadcast?: boolean,
  ) => void;
  spawnSession: (
    channelId: string,
    task: string,
    threadRootEventId?: number,
    opts?: SpawnSessionOptions,
  ) => void;
  /** Spawn the zero-setup scripted demo agent into a channel (harness "demo"). */
  startDemoSession: (channelId: string) => void;
  retry: (m: ChatMessage) => void;
  editMessage: (m: ChatMessage, text: string) => Promise<void>;
  deleteMessage: (m: ChatMessage) => Promise<void>;
  react: (m: ChatMessage, emoji: string) => Promise<void>;
  answerSessionQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  steerSession: (sessionId: string, text: string, effort?: string) => Promise<void>;
  failedSessionSteers: Record<string, string>;
  clearFailedSessionSteer: (sessionId: string) => void;
  cancelSession: (sessionId: string) => Promise<void>;
  stopTurn: (sessionId: string) => Promise<void>;
  failedSessionCancels: Record<string, true>;
  clearFailedSessionCancel: (sessionId: string) => void;
  /** Track the open session so the WS subscribes to its presence key (so
   * control-loop events fold onto the entity). Set on focus, cleared on blur. */
  setActiveSessionId: (sessionId: string | null) => void;
  createChannel: (name: string, isPrivate?: boolean) => Promise<Channel>;
  startDm: (userIds: string[]) => Promise<Channel>;
  channelMembers: (channelId: string) => Promise<UserRef[]>;
  addChannelMember: (channelId: string, userId: string) => Promise<void>;
  leaveMembership: (channelId: string) => Promise<void>;
  mentionUsers: UserRef[] | null;
  loadMentionUsers: () => void;
  setMute: (channelId: string, muted: boolean) => void;
  upsertSession: (session: AgentSession) => void;
  notifyTyping: (channelId: string) => void;
  typing: Record<string, TypingEntry>;
  /** URL for an attachment body — pair with fileHeaders for in-app loads. */
  fileUrl: (fileId: string) => string;
  /** URL for a captured session artifact's bytes — pair with fileHeaders. */
  artifactUrl: (sessionId: string, artifact: Artifact) => string;
  /** Auth headers for in-app image/file loads (expo-image source.headers). */
  fileHeaders: Record<string, string>;
  /** Open a file externally via a short-lived signed URL (never the session). */
  openAttachment: (fileId: string) => Promise<void>;
  uploadFile: (file: {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }) => Promise<AttachmentMeta & { uploadKey: string; localUri: string }>;
  getDraft: (key: string) => Promise<string | null>;
  setDraft: (key: string, text: string) => Promise<void>;
  enqueueDraft: (key: string, text: string) => void;
  markDraftTouched: (key: string) => void;
  setActiveDraftKey: (key: string, active: boolean) => void;
  /** From search: load the message's channel (paging back as needed) + highlight. */
  jumpToMessage: (event: WireEvent) => Promise<void>;
  highlightId: number | null;
  filesEventSeq: number;
}

const ChatContext = createContext<ChatContextValue | null>(null);

const ATTACHMENT_DIR = 'queued-attachments';

type EnqueueOpOptions = {
  onStored?: () => void;
};

type MobileMsgSendPayload = MsgSendPayload & {
  voice?: VoiceSendMeta;
};

function sanitizedFilename(name: string): string {
  const clean = name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 100);
  return clean || 'file';
}

async function copyAttachmentToDocuments(uri: string, uploadKey: string, name: string): Promise<string> {
  if (!FileSystem.documentDirectory) throw new Error('document storage is unavailable');
  const dir = `${FileSystem.documentDirectory}${ATTACHMENT_DIR}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const localUri = `${dir}${uploadKey}-${sanitizedFilename(name)}`;
  await FileSystem.copyAsync({ from: uri, to: localUri });
  return localUri;
}

async function contentHashForUri(uri: string): Promise<string | undefined> {
  try {
    const res = await fetch(uri);
    const blob = await res.blob();
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

async function deleteLocalUri(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export function ChatProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const { invalidate } = useSession();
  const { adoptPrefs } = useTheme();
  const { serverUrl, token, user: me } = session;

  const api = useMemo(
    () => createApi({ baseUrl: serverUrl, getToken: () => token }),
    [serverUrl, token],
  );
  const resolveEntry = useMemo(() => createEntryResolver(session), [session]);
  const resolveArtifactContent = useMemo(() => createArtifactContentResolver(session), [session]);

  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Which channel screen is actually visible (null on the list screen).
  const focusedRef = useRef<string | null>(null);
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [hydrated, setHydrated] = useState(false);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [threadErrors, setThreadErrors] = useState<Record<number, string>>({});
  const [failedSessionSteers, setFailedSessionSteers] = useState<Record<string, string>>({});
  const [failedSessionCancels, setFailedSessionCancels] = useState<Record<string, true>>({});
  const flushOnWakeRef = useRef<() => void>(() => {});
  const [mentionUsers, setMentionUsers] = useState<UserRef[] | null>(null);
  const [queueNudgeSeq, setQueueNudgeSeq] = useState(0);
  const loadingMentionUsersRef = useRef(false);
  const touchedDraftKeysRef = useRef<Set<string>>(new Set());
  const activeDraftKeysRef = useRef<Set<string>>(new Set());
  const calls = useCall({ api, me, channels: state.channels });
  const refreshActiveCalls = calls.refreshActiveCalls;
  const refreshedCallsAfterChannelsLoadRef = useRef(false);

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

  // A dead token can't recover — kick back to login instead of error-looping.
  const onApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) void invalidate();
    },
    [invalidate],
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
      case 'session.stop_turn':
        return "Couldn't cancel the turn.";
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

  const queueDispatch = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      dispatch(action);
      if (action.type === 'server-event' && action.event.channelId) {
        eventCache.enqueueEvents(action.event.channelId, [action.event]);
      }
      if (action.type === 'server-event') cacheSyncCursor(action.event.id);
      if (action.type === 'sync-cursor') cacheSyncCursor(action.cursor);
      if (action.type === 'mute-changed') cacheMute(action.channelId, action.muted);
    },
    [cacheMute, cacheSyncCursor],
  );

  const deleteUploadRefs = useCallback(async (refs: AttachmentRef[] | undefined) => {
    if (!refs || refs.length === 0) return;
    try {
      const ops = await eventCache.listOps();
      await Promise.all(
        refs.map(async (ref) => {
          const op = ops.find((candidate) => candidate.queueKey === `upload:${ref.uploadKey}`);
          const payload = op?.payload as Partial<UploadPayload> | undefined;
          if (payload?.localUri) await deleteLocalUri(payload.localUri).catch(() => {});
        }),
      );
    } catch {
      // Best-effort cleanup; message confirmation/rejection must still settle.
    }
  }, []);

  const opRegistry = useMemo(() => {
    const registry = createDefaultOpRegistry();
    const msgSend = registry['msg.send'];
    registry['msg.send'] = {
      ...msgSend,
      execute: async (apiClient, payload, op, context) => {
        const mobilePayload = payload as MobileMsgSendPayload;
        let attachments = mobilePayload.attachments?.map((a) => a.id);
        if (mobilePayload.attachmentRefs && mobilePayload.attachmentRefs.length > 0) {
          const ops = await context.listOps();
          attachments = mobilePayload.attachmentRefs.map((ref) => {
            const uploadOp = ops.find((candidate) => candidate.queueKey === `upload:${ref.uploadKey}`);
            const uploadPayload = uploadOp?.payload as Partial<UploadPayload> | undefined;
            if (uploadOp?.status !== 'completed' || !uploadPayload?.uploaded || !uploadPayload.fileId) {
              throw new TypeError(`upload ${ref.uploadKey} is not ready`);
            }
            return uploadPayload.fileId;
          });
        }
        return apiClient.postMessage({
          channelId: mobilePayload.channelId,
          text: mobilePayload.text,
          clientMsgId: mobilePayload.clientMsgId,
          threadRootEventId: mobilePayload.threadRootEventId,
          ...(mobilePayload.broadcast === true ? { broadcast: true } : {}),
          attachments,
          voice: mobilePayload.voice,
          opId: op.opId,
        });
      },
      onConfirmed: async (dispatchFn, result, payload, op) => {
        await deleteUploadRefs(payload.attachmentRefs);
        await msgSend.onConfirmed(dispatchFn, result, payload, op);
      },
      onRejected: async (dispatchFn, payload, error, op) => {
        await deleteUploadRefs(payload.attachmentRefs);
        await msgSend.onRejected(dispatchFn, payload, error, op);
      },
    };
    const upload = registry.upload;
    registry.upload = {
      ...upload,
      onRejected: async (dispatchFn, payload, error, op) => {
        await deleteLocalUri(payload.localUri).catch(() => {});
        await upload.onRejected(dispatchFn, payload, error, op);
      },
    };
    return registry;
  }, [deleteUploadRefs]);

  const opQueue = useMemo(
    () =>
      new DurableOpQueue({
        storage: eventCache,
        api,
        dispatch: queueDispatch,
        registry: opRegistry,
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
              .then(({ prefs }) => adoptPrefs(prefs ?? DEFAULT_PREFS))
              .catch(onApiError);
          }
          if (op.opType === 'session.steer') {
            const payload = op.payload as { sessionId?: unknown; text?: unknown };
            if (typeof payload.sessionId === 'string' && typeof payload.text === 'string') {
              const sessionId = payload.sessionId;
              const text = payload.text;
              setFailedSessionSteers((prev) => ({ ...prev, [sessionId]: text }));
            }
          }
          if (op.opType === 'session.cancel' || op.opType === 'session.stop_turn') {
            const payload = op.payload as { sessionId?: unknown };
            if (typeof payload.sessionId === 'string') {
              const sessionId = payload.sessionId;
              setFailedSessionCancels((prev) => ({ ...prev, [sessionId]: true }));
            }
          }
          if (!(err instanceof ApiError && err.status === 401)) {
            Alert.alert('Action failed', queuedFailureMessage(op.opType));
          }
        },
      }),
    [adoptPrefs, api, cacheMute, onApiError, opRegistry, queueDispatch, queuedFailureMessage],
  );

  const markQueueNudged = useCallback(() => {
    setQueueNudgeSeq((n) => n + 1);
  }, []);

  const enqueueOp = useCallback(
    async <T extends OpType>(
      input: EnqueueOpInput<T>,
      options?: EnqueueOpOptions,
    ): Promise<QueuedOp | null> => {
      const op = await opQueue.enqueue(input);
      if (op) {
        options?.onStored?.();
        opQueue.nudge();
        markQueueNudged();
      }
      return op;
    },
    [markQueueNudged, opQueue],
  );

  const clearFailedSessionSteer = useCallback((sessionId: string) => {
    setFailedSessionSteers((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const steerSession = useCallback(
    async (sessionId: string, text: string, effort?: string): Promise<void> => {
      clearFailedSessionSteer(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.steer',
        payload: { sessionId, text, ...(effort ? { effort } : {}) },
      });
    },
    [clearFailedSessionSteer, enqueueOp],
  );

  const clearFailedSessionCancel = useCallback((sessionId: string) => {
    setFailedSessionCancels((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const cancelSession = useCallback(
    async (sessionId: string): Promise<void> => {
      clearFailedSessionCancel(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.cancel',
        payload: { sessionId },
      });
    },
    [clearFailedSessionCancel, enqueueOp],
  );

  const stopTurn = useCallback(
    async (sessionId: string): Promise<void> => {
      clearFailedSessionCancel(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.stop_turn',
        payload: { sessionId },
      });
    },
    [clearFailedSessionCancel, enqueueOp],
  );

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

  const setActiveDraftKey = useCallback((key: string, active: boolean) => {
    if (!key) return;
    if (active) activeDraftKeysRef.current.add(key);
    else activeDraftKeysRef.current.delete(key);
  }, []);

  const reconcileDraftsFromSnapshot = useCallback(
    (snapshot: DraftSnapshot, deletions: DraftDeletionSnapshot = {}) => {
      void eventCache
        .listDrafts()
        .then(async (local) => {
          const { hydrate, remove } = reconcileDraftSnapshot({
            snapshot,
            deletions,
            local,
            touchedThisSession: touchedDraftKeysRef.current,
            activeDraftKeys: activeDraftKeysRef.current,
          });
          await Promise.all(
            Object.entries(hydrate)
              .map(([draftKey, draft]) =>
                eventCache.setDraft(draftKey, draft.text, draft.updatedAt),
              )
              .concat(remove.map((draftKey) => eventCache.setDraft(draftKey, ''))),
          );
        })
        .catch((err: unknown) => {
          console.warn('failed to reconcile draft snapshot', err);
        });
    },
    [],
  );

  const queuedChangesCount = useQueuedChangesCount(eventCache, state.wsStatus, queueNudgeSeq);

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

  useEffect(() => {
    dispatch({ type: 'init-me', handle: me.handle, id: me.id });
  }, [me.handle, me.id]);

  const pendingMessageFromSendPayload = useCallback(
    (msg: MobileMsgSendPayload): ChatMessage => {
      const voiceFileId = msg.voice ? msg.attachments?.[0]?.id : null;
      return {
        id: null,
        clientMsgId: msg.clientMsgId,
        channelId: msg.channelId,
        threadRootEventId: msg.threadRootEventId ?? null,
        ...(msg.broadcast === true ? { broadcast: true } : {}),
        text: msg.text,
        edited: false,
        author: me,
        createdAt: msg.createdAt ?? new Date().toISOString(),
        replyCount: 0,
        lastReplyId: 0,
        status: 'pending',
        ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
        ...(msg.voice && voiceFileId
          ? {
              voice: {
                fileId: voiceFileId,
                durationMs: msg.voice.durationMs,
                waveform: msg.voice.waveform,
                transcript: { status: 'pending' },
              },
            }
          : {}),
      };
    },
    [me],
  );

  const pendingSpawnFromPayload = useCallback(
    (payload: SessionSpawnPayload): { message: ChatMessage; session: AgentSession } => {
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
          repo: payload.repo ?? payload.repos?.[0]?.repo ?? null,
          branch: payload.branch ?? payload.repos?.[0]?.ref ?? null,
          repos: payload.repos ?? null,
          githubIdentityMode: payload.githubIdentityMode ?? null,
          agentProfileVersionId: payload.agentProfileVersionId ?? null,
          spawnedBy: me.id,
          spawnerName: me.displayName,
          driverId: null,
          pendingSeatRequests: [],
          suggestions: [],
          answerProposals: [],
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
    (op: QueuedOp) => {
      if (op.opType === 'msg.send') {
        const payload = op.payload as MobileMsgSendPayload;
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

  useEffect(() => {
    let disposed = false;
    eventCache
      .loadSnapshot()
      .then(async ({ channels, timelines, syncCursor }) => {
        if (disposed) return;
        if (channels) {
          dispatch({ type: 'channels-loaded', channels });
          if (!focusedRef.current) dispatch({ type: 'select-channel', channelId: null });
        }
        for (const [channelId, timeline] of Object.entries(timelines)) {
          dispatch({
            type: 'history-loaded',
            channelId,
            events: timeline.events,
            hasMore: timeline.hasMore,
          });
        }
        if (syncCursor > 0) dispatch({ type: 'sync-cursor', cursor: syncCursor });
        await opQueue.recoverInflight();
        const queued = await eventCache.listOps();
        if (disposed) return;
        for (const op of queued) applyQueuedOp(op);
      })
      .catch((err: unknown) => {
        console.warn('failed to hydrate event cache', err);
      })
      .finally(() => {
        if (!disposed) setHydrated(true);
      });
    return () => {
      disposed = true;
    };
  }, [applyQueuedOp, opQueue]);

  const loadChannels = useCallback(() => {
    setChannelsError(null);
    api
      .channels()
      .then(({ channels }) => {
        setChannelsLoaded(true);
        dispatch({ type: 'channels-loaded', channels });
        void eventCache.saveChannels(channels).catch((err: unknown) => {
          console.warn('failed to cache channels', err);
        });
        // channels-loaded auto-selects a default channel (web behavior); on
        // mobile nothing is focused unless a channel screen is open.
        if (!focusedRef.current) dispatch({ type: 'select-channel', channelId: null });
      })
      .catch((err: unknown) => {
        setChannelsError(err instanceof Error ? err.message : 'Could not load channels');
        onApiError(err);
      });
  }, [api, onApiError]);

  useEffect(() => {
    if (hydrated) loadChannels();
  }, [hydrated, loadChannels]);

  useEffect(() => {
    if (!channelsLoaded || refreshedCallsAfterChannelsLoadRef.current) return;
    refreshedCallsAfterChannelsLoadRef.current = true;
    void refreshActiveCalls();
  }, [channelsLoaded, refreshActiveCalls]);

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
  }, [api]);

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
  }, [adoptPrefs, api, cacheSyncCursor, reconcileDraftsFromSnapshot, resetLoadedTimelinesToLatest]);

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
      .then(() => refreshActiveCalls())
      .then(flushQueuedOps)
      .catch(onApiError);
  }, [flushQueuedOps, onApiError, refreshActiveCalls, runReconnectSync]);

  useEffect(() => {
    flushOnWakeRef.current = syncThenFlushQueuedOps;
  }, [syncThenFlushQueuedOps]);

  // ---- typing indicators (ephemeral, per viewed channel) ----
  const [typing, setTyping] = useState<Record<string, TypingEntry>>({});
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

  // Subscribe to the open session's presence key so its control-loop events
  // (seat hand-off, suggestions, answer proposals) fold onto the entity —
  // mirrors web's wsKeys. The session screen sets activeSessionId on focus.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [filesEventSeq, setFilesEventSeq] = useState(0);
  const wsKeys = useMemo(() => {
    const keys = state.channels.map((c) => c.id);
    if (activeSessionId) keys.push(`session:${activeSessionId}`);
    return keys;
  }, [state.channels, activeSessionId]);
  const wsUrl = useCallback(() => {
    const ws = serverUrl.replace(/^http/i, 'ws');
    return `${ws}/ws?token=${encodeURIComponent(token)}`;
  }, [serverUrl, token]);

  // iOS suspends timers in the background and kills idle sockets silently —
  // tell the WS layer the instant the app is foregrounded again.
  const bindWake = useCallback((cb: () => void) => {
    const sub = RNAppState.addEventListener('change', (s) => {
      if (s === 'active') {
        cb();
        flushOnWakeRef.current();
      }
    });
    return () => sub.remove();
  }, []);

  const ws = useWs(
    hydrated,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
        if (event.type === FILES_CHANGED_EVENT_TYPE) {
          const workspaceId = filesChangedWorkspaceId(event);
          if (workspaceId && stateRef.current.channels.some((channel) => channel.workspaceId === workspaceId)) {
            setFilesEventSeq((n) => n + 1);
          }
          return;
        }
        if (event.type === 'message.posted' && event.actorId) {
          setTyping((prev) => {
            if (!prev[event.actorId!]) return prev;
            const next = { ...prev };
            delete next[event.actorId!];
            return next;
          });
        }
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
        cacheSyncCursor(event.id);
      },
      onPresence: (channelId, users) => dispatch({ type: 'presence', channelId, users }),
      onTyping,
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
      onPrefs: adoptPrefs,
      onChannelLeft: (channelId) => dispatch({ type: 'channel-removed', channelId }),
      onOpen: () => {
        syncThenFlushQueuedOps();
      },
      onStatus: (status) => dispatch({ type: 'ws-status', status }),
    },
    state.activeChannelId,
    { url: wsUrl, onWake: bindWake },
  );

  const lastTypingSentRef = useRef(0);
  const notifyTyping = useCallback(
    (channelId: string) => {
      const now = Date.now();
      if (now - lastTypingSentRef.current < 2500) return;
      lastTypingSentRef.current = now;
      ws.sendTyping(channelId);
    },
    [ws],
  );

  const markRead = useCallback(
    (channelId: string, lastEventId: number) => {
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
    },
    [enqueueOp, onApiError],
  );

  useEffect(
    () => () => {
      for (const timer of Object.values(readTimersRef.current)) clearTimeout(timer);
    },
    [],
  );

  // ---- channel focus + history ----
  const loadHistory = useCallback(
    (channelId: string) => {
      if (stateRef.current.timelines[channelId]?.loaded) return;
      api
        .messages(channelId, { limit: PAGE_SIZE })
        .then(({ events, hasMore }) => {
          // The fetch can resolve after we were kicked from a private channel;
          // dropping it avoids a ghost timeline that catch-up keeps 404-ing on.
          if (!stateRef.current.channels.some((c) => c.id === channelId)) return;
          dispatch({ type: 'history-loaded', channelId, events, hasMore });
          void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
            console.warn('failed to cache history', err);
          });
        })
        .catch(onApiError);
    },
    [api, onApiError],
  );

  const openChannel = useCallback(
    (channelId: string) => {
      focusedRef.current = channelId;
      dispatch({ type: 'select-channel', channelId });
      loadHistory(channelId);
    },
    [loadHistory],
  );

  const leaveChannel = useCallback(() => {
    focusedRef.current = null;
    // While a channel is focused, select-channel suppresses its transient badge.
    // Re-derive from the durable cold counters so leaving before bottom restores it.
    dispatch({ type: 'channels-loaded', channels: stateRef.current.channels });
    dispatch({ type: 'select-channel', channelId: null });
  }, []);

  const loadEarlier = useCallback(
    (channelId: string): Promise<void> => {
      const t = stateRef.current.timelines[channelId];
      const oldest = t?.main.find((m) => m.status === 'confirmed');
      if (!t || !oldest?.id || !t.hasMoreBefore) return Promise.resolve();
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
    },
    [api, onApiError],
  );

  const openThread = useCallback(
    (channelId: string, rootEventId: number) => {
      dispatch({ type: 'open-thread', rootEventId });
      setThreadErrors((prev) => {
        if (!prev[rootEventId]) return prev;
        const next = { ...prev };
        delete next[rootEventId];
        return next;
      });
      api
        .thread(rootEventId)
        .then(({ events }) => dispatch({ type: 'thread-loaded', channelId, rootEventId, events }))
        .catch((err: unknown) => {
          setThreadErrors((prev) => ({
            ...prev,
            [rootEventId]: err instanceof Error ? err.message : 'Could not load replies',
          }));
          onApiError(err);
        });
    },
    [api, onApiError],
  );

  const retryThread = useCallback(
    (channelId: string, rootEventId: number) => {
      openThread(channelId, rootEventId);
    },
    [openThread],
  );

  // ---- sending ----
  const spawnSession = useCallback(
    (channelId: string, task: string, threadRootEventId?: number, opts?: SpawnSessionOptions) => {
      const tempId = `${PENDING_SESSION_PREFIX}${randomId()}`;
      const now = new Date().toISOString();
      const harness = opts?.harness?.trim() || 'codex';
      const repo = opts?.repo?.trim();
      const branch = opts?.branch?.trim();
      const repos = opts?.repos?.length
        ? opts.repos
        : repo
          ? [{ repo, ...(branch ? { ref: branch } : {}) }]
          : [];
      const payload: SessionSpawnPayload = {
        channelId,
        task,
        clientSpawnId: tempId,
        threadRootEventId,
        harness,
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
        ...(repos.length ? { repos } : {}),
        ...(opts?.githubIdentityMode ? { githubIdentityMode: opts.githubIdentityMode } : {}),
        ...(opts?.githubIdentityId ? { githubIdentityId: opts.githubIdentityId } : {}),
        ...(opts?.agentProfileId ? { agentProfileId: opts.agentProfileId } : {}),
        ...(opts?.agentProfileVersionId ? { agentProfileVersionId: opts.agentProfileVersionId } : {}),
        createdAt: now,
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
      ).catch((err: unknown) => {
        onApiError(err);
        dispatch({ type: 'session-spawn-failed', channelId, tempId });
      });
    },
    [enqueueOp, onApiError, pendingSpawnFromPayload],
  );

  // Zero-setup demo: spawns the scripted `demo` harness (streams a short
  // transcript with no provider required) so first-run mobile users can watch an
  // agent work — the mobile analog of web's "Run a demo agent".
  const startDemoSession = useCallback(
    (channelId: string) => {
      spawnSession(channelId, 'Demo — watch an agent work', undefined, { harness: 'demo' });
    },
    [spawnSession],
  );

  const send = useCallback(
    (
      channelId: string,
      text: string,
      threadRootEventId?: number,
      attachments?: AttachmentMeta[],
      attachmentRefs?: AttachmentRef[],
      voice?: VoiceSendMeta,
      broadcast?: boolean,
    ) => {
      // Attachments can't ride along on a session spawn — let "@agent …"
      // with attachments fall through as a plain message rather than drop them.
      const hasAttachments = attachments != null && attachments.length > 0;
      if (!hasAttachments) {
        const task = parseAgentTask(text);
        if (task != null) {
          spawnSession(channelId, task, threadRootEventId);
          return;
        }
        if (looksLikeAgentCommand(text.trim())) {
          Alert.alert('Add a task', 'Type @agent followed by the task to run.');
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
        ...(broadcast === true ? { broadcast: true } : {}),
        text,
        edited: false,
        author: me,
        createdAt,
        replyCount: 0,
        lastReplyId: 0,
        status: 'pending',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(voice && attachments?.[0]
          ? {
              voice: {
                fileId: attachments[0].id,
                durationMs: voice.durationMs,
                waveform: voice.waveform,
                transcript: { status: 'pending' },
              },
            }
          : {}),
      };
      const payload: MobileMsgSendPayload = {
        clientMsgId,
        channelId,
        text,
        threadRootEventId,
        ...(broadcast === true ? { broadcast: true } : {}),
        attachments,
        attachmentRefs,
        createdAt,
        voice,
      };
      void enqueueOp(
        {
          opId: randomId(),
          opType: 'msg.send',
          payload,
        },
        {
          onStored: () => dispatch({ type: 'send-pending', channelId, message }),
        },
      ).catch((err: unknown) => {
        onApiError(err);
        dispatch({ type: 'send-failed', channelId, clientMsgId });
        Alert.alert('Action failed', "Couldn't queue the message.");
      });
    },
    [enqueueOp, me, onApiError, spawnSession],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      if (!m.clientMsgId) return;
      dispatch({ type: 'retry-remove', channelId: m.channelId, clientMsgId: m.clientMsgId });
      if (m.sessionId != null) {
        spawnSession(m.channelId, m.text, m.threadRootEventId ?? undefined);
        return;
      }
      send(
        m.channelId,
        m.text,
        m.threadRootEventId ?? undefined,
        m.attachments,
        undefined,
        m.voice ? { durationMs: m.voice.durationMs, waveform: m.voice.waveform } : undefined,
        m.broadcast === true ? true : undefined,
      );
    },
    [send, spawnSession],
  );

  // A user-triggered mutation that fails must say so — on mobile there is no
  // global toast layer, so each surfaces an Alert (401s route to login).
  const reportActionError = useCallback(
    (err: unknown, message: string) => {
      onApiError(err);
      if (!(err instanceof ApiError && err.status === 401)) Alert.alert('Error', message);
    },
    [onApiError],
  );

  const editMessage = useCallback(
    async (m: ChatMessage, text: string): Promise<void> => {
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
      } catch (err) {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        reportActionError(err, "Couldn't queue the edit.");
      }
    },
    [enqueueOp, reportActionError],
  );

  const deleteMessage = useCallback(
    async (m: ChatMessage): Promise<void> => {
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
      } catch (err) {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        reportActionError(err, "Couldn't queue the delete.");
      }
    },
    [enqueueOp, reportActionError],
  );

  const react = useCallback(
    async (m: ChatMessage, emoji: string): Promise<void> => {
      if (m.id == null) return;
      const eventId = m.id;
      const mine = m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(me.id) === true;
      const action = mine ? 'remove' : 'add';
      const opId = randomId();
      try {
        await enqueueOp(
          {
            opId,
            opType: 'reaction.set',
            payload: { channelId: m.channelId, eventId, emoji, action, userId: me.id },
          },
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
      } catch (err) {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        reportActionError(err, "Couldn't queue the reaction.");
      }
    },
    [enqueueOp, me.id, reportActionError],
  );

  const createChannel = useCallback(
    async (name: string, isPrivate = false) => {
      const { channel } = await api.createChannel(name, { private: isPrivate });
      dispatch({ type: 'channel-added', channel });
      return channel;
    },
    [api],
  );

  const startDm = useCallback(
    async (userIds: string[]) => {
      const { channel } = await api.createDmWithUsers(userIds);
      dispatch({ type: 'channel-added', channel });
      return channel;
    },
    [api],
  );

  const channelMembers = useCallback(
    async (channelId: string) => {
      const { members } = await api.channelMembers(channelId);
      return members;
    },
    [api],
  );

  const addChannelMember = useCallback(
    async (channelId: string, userId: string) => {
      try {
        await enqueueOp({
          opId: randomId(),
          opType: 'channel.join',
          payload: { channelId, userId },
        });
      } catch (err) {
        reportActionError(err, "Couldn't queue the invite.");
        throw err;
      }
    },
    [enqueueOp, reportActionError],
  );

  const leaveMembership = useCallback(
    async (channelId: string) => {
      await enqueueOp({
        opId: randomId(),
        opType: 'channel.leave',
        payload: { channelId, userId: me.id },
      }).catch((err) => {
        reportActionError(err, "Couldn't queue the channel leave.");
        throw err;
      });
    },
    [enqueueOp, me.id, reportActionError],
  );

  const loadMentionUsers = useCallback(() => {
    if (mentionUsers || loadingMentionUsersRef.current) return;
    loadingMentionUsersRef.current = true;
    api
      .users()
      .then(({ users }) => setMentionUsers(users))
      .catch(onApiError)
      .finally(() => {
        loadingMentionUsersRef.current = false;
      });
  }, [api, mentionUsers, onApiError]);

  const setMute = useCallback(
    (channelId: string, muted: boolean) => {
      const previousMuted = stateRef.current.channels.find((c) => c.id === channelId)?.muted === true;
      dispatch({ type: 'mute-changed', channelId, muted });
      cacheMute(channelId, muted);
      void enqueueOp({
        opId: randomId(),
        opType: 'mute.set',
        payload: { channelId, muted, previousMuted },
      }).catch((err: unknown) => {
        onApiError(err);
        dispatch({ type: 'mute-changed', channelId, muted: previousMuted });
        cacheMute(channelId, previousMuted);
      });
    },
    [cacheMute, enqueueOp, onApiError],
  );

  const answerSessionQuestion = useCallback(
    async (
      sessionId: string,
      questionId: string,
      answers: Record<string, { answers: string[] }>,
    ) => {
      await enqueueOp({
        opId: randomId(),
        opType: 'session.answer',
        payload: { sessionId, questionId, answers },
      });
    },
    [enqueueOp],
  );

  const upsertSession = useCallback((agentSession: AgentSession) => {
    dispatch({ type: 'session-upsert', session: agentSession });
  }, []);

  // Heal stale session cards: a session.spawned folded from cached history only
  // advances via live WS events, so a session that finished while the app was
  // closed shows "spawning" forever. Refetch each non-terminal session once to
  // converge on server truth (mirrors web/src/Chat.tsx).
  const reconciledSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const [id, s] of Object.entries(state.sessions)) {
      if (isPendingSessionId(id) || isTerminalSessionStatus(s.status)) continue;
      if (reconciledSessionsRef.current.has(id)) continue;
      reconciledSessionsRef.current.add(id);
      api
        .getSession(id)
        .then(({ session }) => dispatch({ type: 'session-upsert', session: sessionFromWire(session) }))
        .catch(() => {});
    }
  }, [state.sessions, api]);

  // ---- uploads ----
  const uploadFile = useCallback(
    async (file: {
      uri: string;
      name: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
    }): Promise<AttachmentMeta & { uploadKey: string; localUri: string }> => {
      const uploadKey = randomId();
      const localUri = await copyAttachmentToDocuments(file.uri, uploadKey, file.name);
      try {
        const contentHash = await contentHashForUri(localUri);
        const payload: UploadPayload = {
          uploadKey,
          localUri,
          contentHash,
          filename: file.name,
          contentType: file.mimeType,
          size: file.size,
          width: file.width,
          height: file.height,
        };
        await enqueueOp({
          opId: randomId(),
          opType: 'upload',
          payload,
        });
        const { fileId } = await waitForUpload(uploadKey);
        return {
          id: fileId,
          filename: file.name,
          contentType: file.mimeType,
          size: file.size,
          uploadKey,
          localUri,
          ...(file.width ? { width: file.width } : {}),
          ...(file.height ? { height: file.height } : {}),
        };
      } catch (err) {
        await deleteLocalUri(localUri).catch(() => {});
        throw err;
      }
    },
    [enqueueOp, waitForUpload],
  );

  const getDraft = useCallback((key: string) => eventCache.getDraft(key), []);

  const setDraft = useCallback((key: string, text: string) => eventCache.setDraft(key, text), []);

  const fileUrl = useCallback(
    (fileId: string) => `${serverUrl}/api/files/${fileId}`,
    [serverUrl],
  );

  const artifactUrl = useCallback(
    (sessionId: string, artifact: Artifact) =>
      `${serverUrl}/api/sessions/${sessionId}/artifacts/by-path?path=${encodeURIComponent(artifact.path)}`,
    [serverUrl],
  );

  const fileHeaders = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);

  const openAttachment = useCallback(
    async (fileId: string) => {
      try {
        const { url } = await api.fileSignedUrl(fileId);
        await Linking.openURL(`${serverUrl}${url}`);
      } catch (err) {
        reportActionError(err, 'Could not open the file.');
      }
    },
    [api, serverUrl, reportActionError],
  );

  // ---- jump to a message from search: page history back until it's loaded ----
  const [highlightId, setHighlightId] = useState<number | null>(null);
  useEffect(() => {
    if (highlightId == null) return;
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId]);

  const jumpToMessage = useCallback(
    async (event: WireEvent) => {
      const channelId = event.channelId;
      if (!channelId) return;
      loadHistory(channelId);
      for (let tries = 0; tries < 30; tries++) {
        const t = stateRef.current.timelines[channelId];
        if (t?.main.some((m) => m.id === event.id)) break;
        if (!t?.loaded) {
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
    },
    [api, loadHistory],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      state,
      me,
      queuedChangesCount,
      serverUrl,
      api,
      resolveEntry,
      resolveArtifactContent,
      calls,
      channelsLoaded,
      channelsError,
      refreshChannels: loadChannels,
      openChannel,
      leaveChannel,
      markRead,
      loadEarlier,
      openThread,
      retryThread,
      threadErrors,
      send,
      spawnSession,
      startDemoSession,
      retry,
      editMessage,
      deleteMessage,
      react,
      answerSessionQuestion,
      steerSession,
      failedSessionSteers,
      clearFailedSessionSteer,
      cancelSession,
      stopTurn,
      failedSessionCancels,
      clearFailedSessionCancel,
      setActiveSessionId,
      createChannel,
      startDm,
      channelMembers,
      addChannelMember,
      leaveMembership,
      mentionUsers,
      loadMentionUsers,
      setMute,
      upsertSession,
      notifyTyping,
      typing,
      fileUrl,
      artifactUrl,
      fileHeaders,
      openAttachment,
      uploadFile,
      getDraft,
      setDraft,
      enqueueDraft,
      markDraftTouched,
      setActiveDraftKey,
      jumpToMessage,
      highlightId,
      filesEventSeq,
    }),
    [
      state,
      me,
      queuedChangesCount,
      serverUrl,
      api,
      resolveEntry,
      resolveArtifactContent,
      calls,
      channelsLoaded,
      channelsError,
      loadChannels,
      openChannel,
      leaveChannel,
      markRead,
      loadEarlier,
      openThread,
      retryThread,
      threadErrors,
      send,
      spawnSession,
      startDemoSession,
      retry,
      editMessage,
      deleteMessage,
      react,
      answerSessionQuestion,
      steerSession,
      failedSessionSteers,
      clearFailedSessionSteer,
      cancelSession,
      stopTurn,
      failedSessionCancels,
      clearFailedSessionCancel,
      setActiveSessionId,
      createChannel,
      startDm,
      channelMembers,
      addChannelMember,
      leaveMembership,
      mentionUsers,
      loadMentionUsers,
      setMute,
      upsertSession,
      notifyTyping,
      typing,
      fileUrl,
      artifactUrl,
      fileHeaders,
      openAttachment,
      uploadFile,
      getDraft,
      setDraft,
      enqueueDraft,
      markDraftTouched,
      setActiveDraftKey,
      jumpToMessage,
      highlightId,
      filesEventSeq,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat outside ChatProvider');
  return ctx;
}

function upsertUsersById(prev: Record<string, UserRef>, users: UserRef[]): Record<string, UserRef> {
  let next: Record<string, UserRef> | null = null;
  for (const user of users) {
    if (!user.id) continue;
    const existing = (next ?? prev)[user.id];
    if (existing?.handle === user.handle && existing?.displayName === user.displayName) continue;
    next = next ?? { ...prev };
    next[user.id] = user;
  }
  return next ?? prev;
}

export function useReactionUserResolver(messages: ChatMessage[]): ((id: string) => UserRef | undefined) | undefined {
  const ctx = useContext(ChatContext);
  const channels = ctx?.state.channels;
  const channelMembers = ctx?.channelMembers;
  const me = ctx?.me;
  const [usersById, setUsersById] = useState<Record<string, UserRef>>({});
  const loadedChannelIdsRef = useRef<Set<string>>(new Set());
  const loadingChannelIdsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const hasChatContext = ctx != null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const seedUsers = useCallback((users: UserRef[]) => {
    if (users.length === 0) return;
    setUsersById((prev) => upsertUsersById(prev, users));
  }, []);

  const seededUsersById = useMemo(() => {
    const users: UserRef[] = [];
    if (me) users.push(me);
    for (const channel of channels ?? []) users.push(...(channel.members ?? []));
    for (const message of messages) users.push(message.author);
    return upsertUsersById({}, users);
  }, [channels, me, messages]);

  const channelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) ids.add(message.channelId);
    return [...ids];
  }, [messages]);

  useEffect(() => {
    if (!channelMembers) return;
    for (const channelId of channelIds) {
      if (loadedChannelIdsRef.current.has(channelId) || loadingChannelIdsRef.current.has(channelId)) continue;
      loadingChannelIdsRef.current.add(channelId);
      void channelMembers(channelId)
        .then((members) => {
          loadedChannelIdsRef.current.add(channelId);
          if (mountedRef.current) seedUsers(members);
        })
        .catch((err: unknown) => {
          console.warn('failed to load reaction members', err);
        })
        .finally(() => {
          loadingChannelIdsRef.current.delete(channelId);
        });
    }
  }, [channelIds, channelMembers, seedUsers]);

  return useMemo(() => {
    if (!hasChatContext) return undefined;
    return (id: string) => usersById[id] ?? seededUsersById[id];
  }, [hasChatContext, seededUsersById, usersById]);
}
