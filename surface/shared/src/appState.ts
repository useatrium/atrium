// App-level reducer: thin glue around the pure timeline functions in state.ts.

import type { Channel } from './api';
import {
  addPending,
  applyEvent,
  emptyTimeline,
  markFailed,
  mergeHistory,
  mergeThread,
  removeByClientMsgId,
  resolveSpawn,
  type ChannelTimeline,
  type ChatMessage,
  type UserRef,
  type WireEvent,
} from './timeline';
import {
  applySessionEvent,
  maxSessionStatus,
  mergeSpawnResponse,
  type Session,
} from './sessions';

/** 'mention' outranks plain unread — it renders as a red @ badge. */
export type UnreadLevel = false | true | 'mention';

export interface AppState {
  channels: Channel[];
  timelines: Record<string, ChannelTimeline>;
  presence: Record<string, UserRef[]>;
  /** Session entities by id (incl. optimistic `pending:*` ids until POST resolves). */
  sessions: Record<string, Session>;
  activeChannelId: string | null;
  openThreadRootId: number | null;
  openSessionId: string | null;
  /** The open pane's session couldn't be fetched (bad permalink, deleted). */
  openSessionError: boolean;
  unread: Record<string, UnreadLevel>;
  /** Current user's handle — drives @mention unread detection. */
  meHandle: string | null;
  meId: string | null;
  wsStatus: 'connecting' | 'open' | 'closed';
}

export const initialAppState: AppState = {
  channels: [],
  timelines: {},
  presence: {},
  sessions: {},
  activeChannelId: null,
  openThreadRootId: null,
  openSessionId: null,
  openSessionError: false,
  unread: {},
  meHandle: null,
  meId: null,
  wsStatus: 'connecting',
};

export type AppAction =
  | { type: 'init-me'; handle: string; id?: string }
  | { type: 'channels-loaded'; channels: Channel[] }
  | { type: 'read-cursor'; channelId: string; lastReadEventId: number }
  | { type: 'mute-changed'; channelId: string; muted: boolean }
  | { type: 'channel-added'; channel: Channel }
  | { type: 'channel-removed'; channelId: string }
  | { type: 'select-channel'; channelId: string | null }
  | { type: 'history-loaded'; channelId: string; events: WireEvent[]; hasMore: boolean }
  | { type: 'thread-loaded'; channelId: string; rootEventId: number; events: WireEvent[] }
  | { type: 'open-thread'; rootEventId: number }
  | { type: 'close-thread' }
  | { type: 'server-event'; event: WireEvent }
  | { type: 'send-pending'; channelId: string; message: ChatMessage }
  | { type: 'send-failed'; channelId: string; clientMsgId: string }
  | { type: 'retry-remove'; channelId: string; clientMsgId: string }
  | { type: 'presence'; channelId: string; users: UserRef[] }
  | { type: 'ws-status'; status: AppState['wsStatus'] }
  // ---- sessions ----
  | { type: 'session-spawn-pending'; channelId: string; message: ChatMessage; session: Session }
  | { type: 'session-created'; channelId: string; tempId: string; session: Session }
  | { type: 'session-spawn-failed'; channelId: string; tempId: string }
  | { type: 'session-upsert'; session: Session }
  | { type: 'open-session'; sessionId: string }
  | { type: 'session-load-failed'; sessionId: string }
  | { type: 'close-session' };

function timeline(state: AppState, channelId: string): ChannelTimeline {
  return state.timelines[channelId] ?? emptyTimeline;
}

function withTimeline(state: AppState, channelId: string, t: ChannelTimeline): AppState {
  return { ...state, timelines: { ...state.timelines, [channelId]: t } };
}

/** Does `text` @-mention the user? Handles are [a-z0-9_-], so no escaping. */
export function mentionsHandle(text: string, handle: string | null): boolean {
  if (!handle) return false;
  return new RegExp(`@${handle}(?![a-z0-9_-])`, 'i').test(text);
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'init-me':
      return { ...state, meHandle: action.handle, meId: action.id ?? state.meId };

    case 'channels-loaded': {
      const channels = [...action.channels].sort((a, b) => a.name.localeCompare(b.name));
      const activeChannelId =
        state.activeChannelId ??
        channels.find((c) => c.name === 'general')?.id ??
        channels[0]?.id ??
        null;
      let unread = state.unread;
      for (const ch of channels) {
        if (ch.muted) {
          if (unread[ch.id] !== false) unread = { ...unread, [ch.id]: false };
          continue;
        }
        if (unread[ch.id] === 'mention') continue;
        const latest = ch.latestEventId ?? 0;
        const lastRead = ch.lastReadEventId ?? 0;
        const level = latest > lastRead ? true : false;
        if (unread[ch.id] !== level) unread = { ...unread, [ch.id]: level };
        // Cold channel counters cannot identify @mentions because they carry
        // no message text; only live message events can promote to 'mention'.
      }
      return { ...state, channels, activeChannelId, unread };
    }

    case 'read-cursor':
      return { ...state, unread: { ...state.unread, [action.channelId]: false } };

    case 'mute-changed': {
      const channels = state.channels.map((c) =>
        c.id === action.channelId ? { ...c, muted: action.muted } : c,
      );
      let level: UnreadLevel = false;
      if (!action.muted) {
        // Unmuting re-derives unread from the cold counters — messages that
        // arrived while muted were suppressed by the server-event fold.
        const ch = channels.find((c) => c.id === action.channelId);
        level = (ch?.latestEventId ?? 0) > (ch?.lastReadEventId ?? 0);
      }
      return { ...state, channels, unread: { ...state.unread, [action.channelId]: level } };
    }

    case 'channel-added': {
      if (state.channels.some((c) => c.id === action.channel.id)) return state;
      const channels = [...state.channels, action.channel].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      return { ...state, channels };
    }

    case 'channel-removed': {
      const timelines = { ...state.timelines };
      const presence = { ...state.presence };
      const unread = { ...state.unread };
      delete timelines[action.channelId];
      delete presence[action.channelId];
      delete unread[action.channelId];
      return {
        ...state,
        channels: state.channels.filter((c) => c.id !== action.channelId),
        timelines,
        presence,
        unread,
        activeChannelId:
          state.activeChannelId === action.channelId ? null : state.activeChannelId,
        openThreadRootId:
          state.activeChannelId === action.channelId ? null : state.openThreadRootId,
      };
    }

    case 'select-channel':
      // null = no channel focused (mobile list screen) — unreads accrue everywhere.
      return {
        ...state,
        activeChannelId: action.channelId,
        openThreadRootId: null,
        unread: action.channelId
          ? { ...state.unread, [action.channelId]: false }
          : state.unread,
      };

    case 'history-loaded':
      return withTimeline(
        foldSessionEvents(state, action.events),
        action.channelId,
        mergeHistory(timeline(state, action.channelId), action.events, {
          hasMoreBefore: action.hasMore,
        }),
      );

    case 'thread-loaded':
      return withTimeline(
        foldSessionEvents(state, action.events),
        action.channelId,
        mergeThread(timeline(state, action.channelId), action.rootEventId, action.events),
      );

    case 'open-thread':
      return { ...state, openThreadRootId: action.rootEventId, openSessionId: null };

    case 'close-thread':
      return { ...state, openThreadRootId: null };

    case 'server-event': {
      const ev = action.event;
      if (ev.type === 'channel.created') {
        const ch = ev.payload?.channel as Channel | undefined;
        return ch ? appReducer(state, { type: 'channel-added', channel: ch }) : state;
      }
      if (ev.type === 'channel.member_left' && ev.payload?.userId === state.meId) {
        return ev.channelId ? appReducer(state, { type: 'channel-removed', channelId: ev.channelId }) : state;
      }
      let next = state;
      if (ev.type.startsWith('session.')) {
        const sessions = applySessionEvent(state.sessions, ev);
        if (sessions !== state.sessions) next = { ...next, sessions };
      }
      if (!ev.channelId) return next;
      const t = timeline(next, ev.channelId);
      // Only fold timeline events into channels we've actually loaded; untouched
      // channels fetch their history on first open. But always track unread.
      const alreadySeen = t.seenIds.has(ev.id);
      if (t.loaded || t.main.length > 0) {
        let folded = applyEvent(t, ev);
        // DEV MOCK: synthetic events must not advance the catch-up cursor.
        if (ev.mock && folded.lastEventId !== t.lastEventId) {
          folded = { ...folded, lastEventId: t.lastEventId };
        }
        next = withTimeline(next, ev.channelId, folded);
      }
      const isNewMessage =
        (ev.type === 'message.posted' || ev.type === 'session.spawned') && !alreadySeen;
      if (isNewMessage && ev.channelId !== state.activeChannelId) {
        const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
        const channel = state.channels.find((c) => c.id === ev.channelId);
        if (channel?.muted) return next;
        const isDm = channel?.kind === 'dm' || channel?.kind === 'gdm';
        const mentioned =
          isDm || (ev.actorId !== null && mentionsHandle(text, state.meHandle))
            ? 'mention'
            : true;
        // A mention badge sticks until the channel is read.
        const level = next.unread[ev.channelId] === 'mention' ? 'mention' : mentioned;
        next = { ...next, unread: { ...next.unread, [ev.channelId]: level } };
      }
      return next;
    }

    case 'send-pending':
      return withTimeline(
        state,
        action.channelId,
        addPending(timeline(state, action.channelId), action.message),
      );

    case 'send-failed':
      return withTimeline(
        state,
        action.channelId,
        markFailed(timeline(state, action.channelId), action.clientMsgId),
      );

    case 'retry-remove': {
      const next = withTimeline(
        state,
        action.channelId,
        removeByClientMsgId(timeline(state, action.channelId), action.clientMsgId),
      );
      // Failed spawns use the temp session id as clientMsgId — drop the entity.
      if (next.sessions[action.clientMsgId]) {
        const sessions = { ...next.sessions };
        delete sessions[action.clientMsgId];
        return { ...next, sessions };
      }
      return next;
    }

    case 'presence':
      return { ...state, presence: { ...state.presence, [action.channelId]: action.users } };

    case 'ws-status':
      return { ...state, wsStatus: action.status };

    // ---- sessions ----

    case 'session-spawn-pending':
      return {
        ...withTimeline(
          state,
          action.channelId,
          addPending(timeline(state, action.channelId), action.message),
        ),
        sessions: { ...state.sessions, [action.session.id]: action.session },
      };

    case 'session-created': {
      const sessions = { ...state.sessions };
      delete sessions[action.tempId];
      sessions[action.session.id] = mergeSpawnResponse(
        state.sessions[action.session.id],
        action.session,
      );
      return {
        ...withTimeline(
          state,
          action.channelId,
          resolveSpawn(timeline(state, action.channelId), action.tempId, action.session.id),
        ),
        sessions,
      };
    }

    case 'session-spawn-failed': {
      const next = withTimeline(
        state,
        action.channelId,
        markFailed(timeline(state, action.channelId), action.tempId),
      );
      const temp = next.sessions[action.tempId];
      if (!temp) return next;
      return {
        ...next,
        sessions: { ...next.sessions, [action.tempId]: { ...temp, status: 'failed' } },
      };
    }

    case 'session-upsert': {
      const existing = state.sessions[action.session.id];
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.session.id]: {
            ...action.session,
            // A slow GET must never roll back a status WS already advanced.
            status: existing
              ? maxSessionStatus(existing.status, action.session.status)
              : action.session.status,
            spawnerName: action.session.spawnerName ?? existing?.spawnerName,
            driverName: action.session.driverName ?? existing?.driverName,
            // GET /api/sessions/:id carries no audit history — keep what the
            // live seat_changed folds already accumulated.
            seatEvents:
              action.session.seatEvents.length > 0
                ? action.session.seatEvents
                : existing?.seatEvents ?? [],
          },
        },
      };
    }

    case 'open-session':
      return {
        ...state,
        openSessionId: action.sessionId,
        openSessionError: false,
        openThreadRootId: null,
      };

    case 'session-load-failed':
      // Only matters while that session is the open pane and has no entity to
      // render from — the pane placeholder switches to a not-found state.
      if (state.openSessionId !== action.sessionId) return state;
      return { ...state, openSessionError: true };

    case 'close-session':
      return { ...state, openSessionId: null, openSessionError: false };

    default:
      return state;
  }
}

/** Build/refresh session entities from any `session.*` events in a fetched page. */
function foldSessionEvents(state: AppState, events: WireEvent[]): AppState {
  let sessions = state.sessions;
  for (const ev of events) {
    if (ev.type.startsWith('session.')) sessions = applySessionEvent(sessions, ev);
  }
  return sessions === state.sessions ? state : { ...state, sessions };
}
