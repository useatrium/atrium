import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, type Workspace } from './api';
import { appReducer, initialAppState, mentionsHandle } from '@atrium/surface-client';
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
import { QuickSwitcher } from './components/QuickSwitcher';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';
import { sessionsApi } from './sessions/api';
import { sessionsMockBus } from './sessions/devMock';
import { SessionPane } from './sessions/SessionPane';
import { spawnSession, trySpawnFromComposer } from './sessions/spawn';
import { isPendingSessionId, isTerminalSessionStatus, sessionFromWire } from './sessions/types';
import { channelLabel, dmPartner } from '@atrium/surface-client';

const PAGE_SIZE = 50;
const NO_WATCHERS: UserRef[] = [];

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
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ---- initial data ----
  useEffect(() => {
    dispatch({ type: 'init-me', handle: me.handle });
  }, [me.handle]);
  useEffect(() => {
    api.channels().then(({ channels }) => dispatch({ type: 'channels-loaded', channels }));
  }, []);

  // ---- permalink (/s/:id): load the session, jump to its channel, open pane ----
  useEffect(() => {
    if (!initialSessionId) return;
    dispatch({ type: 'open-session', sessionId: initialSessionId });
    sessionsApi
      .get(initialSessionId)
      .then(({ session }) => {
        dispatch({ type: 'session-upsert', session: sessionFromWire(session) });
        if (session.channelId) dispatch({ type: 'select-channel', channelId: session.channelId });
        dispatch({ type: 'open-session', sessionId: session.id });
      })
      .catch(() => dispatch({ type: 'session-load-failed', sessionId: initialSessionId }));
  }, [initialSessionId]);

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

  const catchUp = useCallback(() => {
    // On (re)connect: refetch anything we might have missed per loaded channel.
    const s = stateRef.current;
    for (const [channelId, t] of Object.entries(s.timelines)) {
      if (!t.loaded) continue;
      api
        .messages(channelId, t.lastEventId > 0 ? { afterId: t.lastEventId } : { limit: PAGE_SIZE })
        .then(({ events, hasMore }) => {
          if (t.lastEventId > 0) {
            for (const ev of events) dispatch({ type: 'server-event', event: ev });
            if (hasMore) catchUp(); // keep paging until caught up
          } else {
            dispatch({ type: 'history-loaded', channelId, events, hasMore });
          }
        })
        .catch(() => {});
    }
    api.channels().then(({ channels }) => dispatch({ type: 'channels-loaded', channels }));
  }, []);

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
    true,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
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
      onMuted: (channelId, muted) => dispatch({ type: 'mute-changed', channelId, muted }),
      onOpen: catchUp,
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
      const isDm = ch?.kind === 'dm';
      if (!isDm && !mentionsHandle(text, me.handle)) return;
      const author = event.author?.displayName ?? 'Someone';
      showNotification(
        isDm ? `${author} (direct message)` : `${author} mentioned you in #${ch?.name ?? 'a channel'}`,
        text.slice(0, 140),
        `evt-${event.id}`,
        () => {
          if (event.channelId) dispatch({ type: 'select-channel', channelId: event.channelId });
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
      api
        .markRead(channelId, lastEventId)
        .then(({ lastReadEventId }) => {
          lastReadSentRef.current[channelId] = Math.max(
            lastReadSentRef.current[channelId] ?? 0,
            lastReadEventId,
          );
          dispatch({ type: 'read-cursor', channelId, lastReadEventId });
        })
        .catch(() => {
          if (lastReadSentRef.current[channelId] === lastEventId) {
            lastReadSentRef.current[channelId] = previous;
          }
        });
    };
    const elapsed = Date.now() - (lastReadAtRef.current[channelId] ?? 0);
    if (elapsed >= 2000) {
      fire();
      return;
    }
    if (readTimersRef.current[channelId]) clearTimeout(readTimersRef.current[channelId]);
    readTimersRef.current[channelId] = setTimeout(fire, 2000 - elapsed);
  }, []);

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
      .then(({ events, hasMore }) => dispatch({ type: 'history-loaded', channelId, events, hasMore }));
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadEarlier = (): Promise<void> => {
    if (!active) return Promise.resolve();
    const oldest = timeline.main.find((m) => m.status === 'confirmed');
    if (!oldest?.id) return Promise.resolve();
    const channelId = active.id;
    return api
      .messages(channelId, { beforeId: oldest.id, limit: PAGE_SIZE })
      .then(({ events, hasMore }) =>
        dispatch({ type: 'history-loaded', channelId, events, hasMore }),
      );
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
      .catch(() => {});
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
  const send = (
    channelId: string,
    text: string,
    threadRootEventId?: number,
    attachments?: AttachmentMeta[],
  ) => {
    // Attachments can't ride along on a spawn — "@agent …" with files attached
    // sends as a plain message instead of silently dropping them.
    const noAttachments = !attachments || attachments.length === 0;
    if (text && noAttachments && trySpawnFromComposer(text, { channelId, threadRootEventId, me, dispatch }))
      return;
    const clientMsgId = crypto.randomUUID();
    const message: ChatMessage = {
      id: null,
      clientMsgId,
      channelId,
      threadRootEventId: threadRootEventId ?? null,
      text,
      edited: false,
      author: me,
      createdAt: new Date().toISOString(),
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
      .then(({ event }) => dispatch({ type: 'server-event', event }))
      .catch(() => dispatch({ type: 'send-failed', channelId, clientMsgId }));
  };

  const editMessage = (m: ChatMessage, text: string): Promise<void> =>
    api.editMessage(m.id!, text).then(({ event }) => dispatch({ type: 'server-event', event }));

  const removeMessage = (m: ChatMessage): Promise<void> =>
    api.deleteMessage(m.id!).then(({ event }) => dispatch({ type: 'server-event', event }));

  const reactToMessage = (m: ChatMessage, emoji: string): Promise<void> =>
    api.toggleReaction(m.id!, emoji).then(({ event }) => dispatch({ type: 'server-event', event }));

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
    dispatch({ type: 'select-channel', channelId });
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
      const { events, hasMore } = await api.messages(channelId, {
        beforeId: oldest.id,
        limit: PAGE_SIZE,
      });
      dispatch({ type: 'history-loaded', channelId, events, hasMore });
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
      spawnSession(m.text, {
        channelId: m.channelId,
        threadRootEventId: m.threadRootEventId ?? undefined,
        me,
        dispatch,
      });
      return;
    }
    send(m.channelId, m.text, m.threadRootEventId ?? undefined, m.attachments);
  };

  const createChannel = async (name: string) => {
    const { channel } = await api.createChannel(name);
    dispatch({ type: 'channel-added', channel });
    dispatch({ type: 'select-channel', channelId: channel.id });
  };

  const startDm = (userId: string) => {
    api
      .createDm(userId)
      .then(({ channel }) => {
        dispatch({ type: 'channel-added', channel });
        dispatch({ type: 'select-channel', channelId: channel.id });
      })
      .catch(() => {});
  };

  const setMute = (channelId: string, muted: boolean) => {
    dispatch({ type: 'mute-changed', channelId, muted });
    api
      .setMute(channelId, muted)
      .then((res) => dispatch({ type: 'mute-changed', channelId, muted: res.muted }))
      .catch(() => dispatch({ type: 'mute-changed', channelId, muted: !muted }));
  };

  const presentUsers = active ? state.presence[active.id] ?? [] : [];

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

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={state.activeChannelId}
        unread={state.unread}
        me={me}
        wsStatus={state.wsStatus}
        onSelect={(channelId) => dispatch({ type: 'select-channel', channelId })}
        onSetMute={setMute}
        onCreateChannel={createChannel}
        onStartDm={startDm}
        onLogout={onLogout}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
          <h1 className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
            {active?.kind === 'dm' ? (
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
                <span className="mr-0.5 text-zinc-500">#</span>
                {active?.name ?? '…'}
              </>
            )}
          </h1>
          {presentUsers.length > 0 && (
            <div
              className="ml-auto flex items-center gap-2"
              title="Viewing this channel right now"
            >
              <div className="flex -space-x-1.5">
                {presentUsers.slice(0, 8).map((u) => (
                  <div key={u.id} className="rounded-md ring-2 ring-zinc-950">
                    <Avatar name={u.displayName} seed={u.id} size={20} />
                  </div>
                ))}
              </div>
              <span className="text-[11px] tabular-nums text-zinc-500">
                {presentUsers.length} here
              </span>
            </div>
          )}
        </header>

        {state.wsStatus === 'closed' && (
          <div
            role="status"
            className="flex shrink-0 items-center justify-center border-b border-amber-900/40 bg-amber-950/30 px-4 py-1 text-[11px] text-amber-300"
          >
            Connection lost — reconnecting…
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
        />

        {active && (
          <>
            <TypingLine typing={typing} />
            <Composer
              placeholder={
                active.kind === 'dm'
                  ? `Message ${channelLabel(active, me.id)}`
                  : `Message #${active.name}`
              }
              onSend={(text, attachments) => send(active.id, text, undefined, attachments)}
              onTyping={() => notifyTyping(active.id)}
              onArrowUpOnEmpty={editLastOwn}
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
        />
      ) : state.openSessionId ? (
        <aside className="flex w-[min(520px,42vw)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
            <span className="text-sm font-semibold text-zinc-100">Session</span>
            <button
              onClick={() => dispatch({ type: 'close-session' })}
              title="Close session pane"
              aria-label="Close session pane"
              className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
          </header>
          {state.openSessionError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="text-sm font-medium text-zinc-300">Session not found</div>
              <div className="text-xs text-zinc-500">
                It may have been removed, or the link is wrong.
              </div>
              <button
                onClick={() => dispatch({ type: 'close-session' })}
                className="mt-2 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
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
            onSend={(text, attachments) => send(active.id, text, openThreadRoot.id!, attachments)}
            onOpenSession={openSession}
            onRetry={retry}
            onEdit={editMessage}
            onDelete={removeMessage}
            onReact={reactToMessage}
          />
        )
      )}

      {switcherOpen && (
        <QuickSwitcher
          channels={state.channels}
          activeChannelId={state.activeChannelId}
          meId={me.id}
          onSelect={(channelId) => {
            dispatch({ type: 'select-channel', channelId });
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
    <div aria-live="polite" className="h-5 shrink-0 px-4 text-[11px] leading-5 text-zinc-500">
      {label}
    </div>
  );
}
