import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, type Workspace } from './api';
import { appReducer, initialAppState } from './appState';
import { emptyTimeline, type ChatMessage, type UserRef, type WireEvent } from './state';
import { useWs } from './useWs';
import { Avatar } from './components/Avatar';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { ThreadPanel } from './components/ThreadPanel';
import { Timeline } from './components/Timeline';

const PAGE_SIZE = 50;

export function Chat({
  me,
  workspace,
  onLogout,
}: {
  me: UserRef;
  workspace: Workspace;
  onLogout: () => void;
}) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- initial data ----
  useEffect(() => {
    api.channels().then(({ channels }) => dispatch({ type: 'channels-loaded', channels }));
  }, []);

  // ---- websocket ----
  const channelIds = useMemo(() => state.channels.map((c) => c.id), [state.channels]);

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

  useWs(true, channelIds, {
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

  const loadEarlier = () => {
    if (!active) return;
    const oldest = timeline.main.find((m) => m.status === 'confirmed');
    if (!oldest?.id) return;
    const channelId = active.id;
    api
      .messages(channelId, { beforeId: oldest.id, limit: PAGE_SIZE })
      .then(({ events, hasMore }) => dispatch({ type: 'history-loaded', channelId, events, hasMore }));
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

  // ---- sending ----
  const send = (channelId: string, text: string, threadRootEventId?: number) => {
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
    send(m.channelId, m.text, m.threadRootEventId ?? undefined);
  };

  const createChannel = async (name: string) => {
    const { channel } = await api.createChannel(name);
    dispatch({ type: 'channel-added', channel });
    dispatch({ type: 'select-channel', channelId: channel.id });
  };

  const presentUsers = active ? state.presence[active.id] ?? [] : [];

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        workspaceName={workspace.name}
        channels={state.channels}
        activeChannelId={state.activeChannelId}
        unread={state.unread}
        presence={state.presence}
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
            <div className="ml-auto flex items-center gap-2">
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

        <Timeline
          messages={timeline.main}
          hasMoreBefore={timeline.hasMoreBefore}
          onLoadEarlier={loadEarlier}
          onOpenThread={openThread}
          onRetry={retry}
        />

        {active && (
          <Composer
            placeholder={`Message #${active.name}`}
            onSend={(text) => send(active.id, text)}
            autoFocus
          />
        )}
      </main>

      {openThreadRoot && active && (
        <ThreadPanel
          root={openThreadRoot}
          replies={threadReplies}
          onClose={() => dispatch({ type: 'close-thread' })}
          onSend={(text) => send(active.id, text, openThreadRoot.id!)}
          onRetry={retry}
        />
      )}
    </div>
  );
}
