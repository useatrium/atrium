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
import { AppState as RNAppState, Linking } from 'react-native';
import { randomUUID } from 'expo-crypto';
import {
  ApiError,
  appReducer,
  createApi,
  initialAppState,
  useWs,
  type Api,
  type AppState,
  type AttachmentMeta,
  type Channel,
  type ChatMessage,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';
import { useSession, type Session } from './session';
import type { OutboxMessage } from './cache';
import { eventCache } from './cacheSqlite';
import {
  flushOutbox,
  isNetworkFailure,
  outboxMessageFromSend,
} from './outbox';

const PAGE_SIZE = 50;

export interface TypingEntry {
  user: UserRef;
  until: number;
}

interface ChatContextValue {
  state: AppState;
  me: UserRef;
  api: Api;
  /** Channel screen came into focus: select it, mark read, load history. */
  openChannel: (channelId: string) => void;
  /** Channel screen lost focus: unreads accrue everywhere again. */
  leaveChannel: () => void;
  loadEarlier: (channelId: string) => Promise<void>;
  openThread: (channelId: string, rootEventId: number) => void;
  send: (
    channelId: string,
    text: string,
    threadRootEventId?: number,
    attachments?: AttachmentMeta[],
  ) => void;
  retry: (m: ChatMessage) => void;
  editMessage: (m: ChatMessage, text: string) => Promise<void>;
  deleteMessage: (m: ChatMessage) => Promise<void>;
  react: (m: ChatMessage, emoji: string) => Promise<void>;
  createChannel: (name: string) => Promise<Channel>;
  startDm: (userId: string) => Promise<Channel>;
  notifyTyping: (channelId: string) => void;
  typing: Record<string, TypingEntry>;
  /** URL for an attachment body — pair with fileHeaders for in-app loads. */
  fileUrl: (fileId: string) => string;
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
  }) => Promise<AttachmentMeta>;
  getDraft: (key: string) => Promise<string | null>;
  setDraft: (key: string, text: string) => Promise<void>;
  /** From search: load the message's channel (paging back as needed) + highlight. */
  jumpToMessage: (event: WireEvent) => Promise<void>;
  highlightId: number | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const { invalidate } = useSession();
  const { serverUrl, token, user: me } = session;

  const api = useMemo(
    () => createApi({ baseUrl: serverUrl, getToken: () => token }),
    [serverUrl, token],
  );

  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Which channel screen is actually visible (null on the list screen).
  const focusedRef = useRef<string | null>(null);
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [hydrated, setHydrated] = useState(false);
  const flushingOutboxRef = useRef(false);
  const flushOnWakeRef = useRef<() => void>(() => {});

  // A dead token can't recover — kick back to login instead of error-looping.
  const onApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) void invalidate();
    },
    [invalidate],
  );

  useEffect(() => {
    dispatch({ type: 'init-me', handle: me.handle });
  }, [me.handle]);

  const pendingMessageFromOutbox = useCallback(
    (msg: OutboxMessage): ChatMessage => ({
      id: null,
      clientMsgId: msg.clientMsgId,
      channelId: msg.channelId,
      threadRootEventId: msg.threadRootEventId ?? null,
      text: msg.text,
      edited: false,
      author: me,
      createdAt: msg.createdAt,
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    }),
    [me],
  );

  useEffect(() => {
    let disposed = false;
    eventCache
      .loadSnapshot()
      .then(async ({ channels, timelines }) => {
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
        const queued = await eventCache.listOutbox();
        if (disposed) return;
        for (const msg of queued) {
          dispatch({
            type: 'send-pending',
            channelId: msg.channelId,
            message: pendingMessageFromOutbox(msg),
          });
        }
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
  }, [pendingMessageFromOutbox]);

  const loadChannels = useCallback(() => {
    api
      .channels()
      .then(({ channels }) => {
        dispatch({ type: 'channels-loaded', channels });
        void eventCache.saveChannels(channels).catch((err: unknown) => {
          console.warn('failed to cache channels', err);
        });
        // channels-loaded auto-selects a default channel (web behavior); on
        // mobile nothing is focused unless a channel screen is open.
        if (!focusedRef.current) dispatch({ type: 'select-channel', channelId: null });
      })
      .catch(onApiError);
  }, [api, onApiError]);

  useEffect(() => {
    if (hydrated) loadChannels();
  }, [hydrated, loadChannels]);

  // ---- reconnect catch-up: refetch what we might have missed ----
  const catchUp = useCallback(() => {
    const s = stateRef.current;
    for (const [channelId, t] of Object.entries(s.timelines)) {
      if (!t.loaded) continue;
      api
        .messages(channelId, t.lastEventId > 0 ? { afterId: t.lastEventId } : { limit: PAGE_SIZE })
        .then(({ events, hasMore }) => {
          if (t.lastEventId > 0) {
            for (const ev of events) dispatch({ type: 'server-event', event: ev });
            if (events.length > 0) eventCache.enqueueEvents(channelId, events);
            if (hasMore) catchUp();
          } else {
            dispatch({ type: 'history-loaded', channelId, events, hasMore });
            void eventCache.saveTimeline(channelId, events, hasMore).catch((err: unknown) => {
              console.warn('failed to cache catch-up history', err);
            });
          }
        })
        .catch(onApiError);
    }
    loadChannels();
  }, [api, loadChannels, onApiError]);

  const flushQueuedOutbox = useCallback(() => {
    if (flushingOutboxRef.current) return;
    flushingOutboxRef.current = true;
    void flushOutbox({
      storage: eventCache,
      postMessage: api.postMessage,
      onConfirmed: (event) => {
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
      },
      onRejected: (msg) => {
        dispatch({ type: 'send-failed', channelId: msg.channelId, clientMsgId: msg.clientMsgId });
      },
    })
      .catch(onApiError)
      .finally(() => {
        flushingOutboxRef.current = false;
      });
  }, [api, onApiError]);

  useEffect(() => {
    flushOnWakeRef.current = flushQueuedOutbox;
  }, [flushQueuedOutbox]);

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

  const wsKeys = useMemo(() => state.channels.map((c) => c.id), [state.channels]);
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
      onOpen: () => {
        catchUp();
        flushQueuedOutbox();
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
        api
          .markRead(channelId, lastEventId)
          .then(({ lastReadEventId }) => {
            lastReadSentRef.current[channelId] = Math.max(
              lastReadSentRef.current[channelId] ?? 0,
              lastReadEventId,
            );
            dispatch({ type: 'read-cursor', channelId, lastReadEventId });
          })
          .catch((err) => {
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
    [api, onApiError],
  );

  useEffect(() => {
    const channelId = focusedRef.current;
    if (!channelId) return;
    markRead(channelId, state.timelines[channelId]?.lastEventId ?? 0);
  }, [markRead, state.timelines]);

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
      markRead(channelId, stateRef.current.timelines[channelId]?.lastEventId ?? 0);
      loadHistory(channelId);
    },
    [loadHistory, markRead],
  );

  const leaveChannel = useCallback(() => {
    focusedRef.current = null;
    dispatch({ type: 'select-channel', channelId: null });
  }, []);

  const loadEarlier = useCallback(
    (channelId: string): Promise<void> => {
      const t = stateRef.current.timelines[channelId];
      const oldest = t?.main.find((m) => m.status === 'confirmed');
      if (!t || !oldest?.id || !t.hasMoreBefore) return Promise.resolve();
      return api
        .messages(channelId, { beforeId: oldest.id, limit: PAGE_SIZE })
        .then(({ events, hasMore }) => {
          dispatch({ type: 'history-loaded', channelId, events, hasMore });
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
      api
        .thread(rootEventId)
        .then(({ events }) => dispatch({ type: 'thread-loaded', channelId, rootEventId, events }))
        .catch(onApiError);
    },
    [api, onApiError],
  );

  // ---- sending ----
  const send = useCallback(
    (
      channelId: string,
      text: string,
      threadRootEventId?: number,
      attachments?: AttachmentMeta[],
    ) => {
      const clientMsgId = randomUUID();
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
      api
        .postMessage({
          channelId,
          text,
          clientMsgId,
          threadRootEventId,
          attachments: attachments?.map((a) => a.id),
        })
        .then(({ event }) => {
          dispatch({ type: 'server-event', event });
          if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
        })
        .catch((err) => {
          if (isNetworkFailure(err)) {
            void eventCache
              .enqueueOutbox(
                outboxMessageFromSend({
                  clientMsgId,
                  channelId,
                  text,
                  threadRootEventId,
                  attachments,
                  createdAt,
                }),
              )
              .catch((cacheErr: unknown) => {
                console.warn('failed to queue offline message', cacheErr);
              });
            return;
          }
          onApiError(err);
          dispatch({ type: 'send-failed', channelId, clientMsgId });
        });
    },
    [api, me, onApiError],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      if (!m.clientMsgId) return;
      dispatch({ type: 'retry-remove', channelId: m.channelId, clientMsgId: m.clientMsgId });
      send(m.channelId, m.text, m.threadRootEventId ?? undefined, m.attachments);
    },
    [send],
  );

  const editMessage = useCallback(
    (m: ChatMessage, text: string): Promise<void> =>
      api.editMessage(m.id!, text).then(({ event }) => {
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
      }),
    [api],
  );

  const deleteMessage = useCallback(
    (m: ChatMessage): Promise<void> =>
      api.deleteMessage(m.id!).then(({ event }) => {
        dispatch({ type: 'server-event', event });
        if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
      }),
    [api],
  );

  const react = useCallback(
    (m: ChatMessage, emoji: string): Promise<void> =>
      api
        .toggleReaction(m.id!, emoji)
        .then(({ event }) => {
          dispatch({ type: 'server-event', event });
          if (event.channelId) eventCache.enqueueEvents(event.channelId, [event]);
        }),
    [api],
  );

  const createChannel = useCallback(
    async (name: string) => {
      const { channel } = await api.createChannel(name);
      dispatch({ type: 'channel-added', channel });
      return channel;
    },
    [api],
  );

  const startDm = useCallback(
    async (userId: string) => {
      const { channel } = await api.createDm(userId);
      dispatch({ type: 'channel-added', channel });
      return channel;
    },
    [api],
  );

  // ---- uploads ----
  const uploadFile = useCallback(
    async (file: {
      uri: string;
      name: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
    }): Promise<AttachmentMeta> => {
      const { fileId, uploadUrl } = await api.createUpload({
        filename: file.name,
        contentType: file.mimeType,
        size: file.size,
        width: file.width,
        height: file.height,
      });
      const blob = await (await fetch(file.uri)).blob();
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.mimeType },
        body: blob,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      return {
        id: fileId,
        filename: file.name,
        contentType: file.mimeType,
        size: file.size,
        ...(file.width ? { width: file.width } : {}),
        ...(file.height ? { height: file.height } : {}),
      };
    },
    [api],
  );

  const getDraft = useCallback((key: string) => eventCache.getDraft(key), []);

  const setDraft = useCallback((key: string, text: string) => eventCache.setDraft(key, text), []);

  const fileUrl = useCallback(
    (fileId: string) => `${serverUrl}/api/files/${fileId}`,
    [serverUrl],
  );

  const fileHeaders = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);

  const openAttachment = useCallback(
    async (fileId: string) => {
      try {
        const { url } = await api.fileSignedUrl(fileId);
        await Linking.openURL(`${serverUrl}${url}`);
      } catch (err) {
        onApiError(err);
      }
    },
    [api, serverUrl, onApiError],
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
        const { events, hasMore } = await api.messages(channelId, {
          beforeId: oldest.id,
          limit: PAGE_SIZE,
        });
        dispatch({ type: 'history-loaded', channelId, events, hasMore });
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
      api,
      openChannel,
      leaveChannel,
      loadEarlier,
      openThread,
      send,
      retry,
      editMessage,
      deleteMessage,
      react,
      createChannel,
      startDm,
      notifyTyping,
      typing,
      fileUrl,
      fileHeaders,
      openAttachment,
      uploadFile,
      getDraft,
      setDraft,
      jumpToMessage,
      highlightId,
    }),
    [
      state,
      me,
      api,
      openChannel,
      leaveChannel,
      loadEarlier,
      openThread,
      send,
      retry,
      editMessage,
      deleteMessage,
      react,
      createChannel,
      startDm,
      notifyTyping,
      typing,
      fileUrl,
      fileHeaders,
      openAttachment,
      uploadFile,
      getDraft,
      setDraft,
      jumpToMessage,
      highlightId,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat outside ChatProvider');
  return ctx;
}
