import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, type Workspace } from './api';
import { appReducer, initialAppState } from './appState';
import { emptyTimeline, type ChatMessage, type UserRef, type WireEvent } from './state';
import { useWs } from './useWs';
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

  // ---- initial data ----
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

  useWs(true, wsKeys, {
    onEvent: (event: WireEvent) => dispatch({ type: 'server-event', event }),
    onPresence: (channelId, users) => dispatch({ type: 'presence', channelId, users }),
    onOpen: catchUp,
    onStatus: (status) => dispatch({ type: 'ws-status', status }),
  });

  // ---- channel selection & history ----
  const active = state.channels.find((c) => c.id === state.activeChannelId) ?? null;
  const timeline = (active && state.timelines[active.id]) || emptyTimeline;

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
  const send = (channelId: string, text: string, threadRootEventId?: number) => {
    if (trySpawnFromComposer(text, { channelId, threadRootEventId, me, dispatch })) return;
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
    };
    dispatch({ type: 'send-pending', channelId, message });
    api
      .postMessage({ channelId, text, clientMsgId, threadRootEventId })
      .then(({ event }) => dispatch({ type: 'server-event', event }))
      .catch(() => dispatch({ type: 'send-failed', channelId, clientMsgId }));
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
    send(m.channelId, m.text, m.threadRootEventId ?? undefined);
  };

  const createChannel = async (name: string) => {
    const { channel } = await api.createChannel(name);
    dispatch({ type: 'channel-added', channel });
    dispatch({ type: 'select-channel', channelId: channel.id });
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
        onCreateChannel={createChannel}
        onLogout={onLogout}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
          <h1 className="text-sm font-bold text-zinc-100">
            <span className="mr-0.5 text-zinc-500">#</span>
            {active?.name ?? '…'}
          </h1>
          {presentUsers.length > 0 && (
            <div
              className="ml-auto flex items-center gap-2"
              title="Teammates connected to the workspace"
            >
              <div className="flex -space-x-1.5">
                {presentUsers.slice(0, 8).map((u) => (
                  <div key={u.id} className="rounded-md ring-2 ring-zinc-950">
                    <Avatar name={u.displayName} seed={u.id} size={20} />
                  </div>
                ))}
              </div>
              <span className="text-[11px] tabular-nums text-zinc-500">
                {presentUsers.length} online
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
          onLoadEarlier={loadEarlier}
          onOpenThread={openThread}
          onOpenSession={openSession}
          onRetry={retry}
        />

        {active && (
          <Composer
            placeholder={`Message #${active.name}`}
            onSend={(text) => send(active.id, text)}
            autoFocus
            agentAware
          />
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
            onClose={() => dispatch({ type: 'close-thread' })}
            onSend={(text) => send(active.id, text, openThreadRoot.id!)}
            onOpenSession={openSession}
            onRetry={retry}
          />
        )
      )}

      {switcherOpen && (
        <QuickSwitcher
          channels={state.channels}
          activeChannelId={state.activeChannelId}
          onSelect={(channelId) => {
            dispatch({ type: 'select-channel', channelId });
            setSwitcherOpen(false);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
