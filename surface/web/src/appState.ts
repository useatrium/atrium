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
} from './state';
import {
  applySessionEvent,
  maxSessionStatus,
  mergeSpawnResponse,
  type Session,
} from './sessions/types';

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
  unread: Record<string, boolean>;
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
  wsStatus: 'connecting',
};

export type AppAction =
  | { type: 'channels-loaded'; channels: Channel[] }
  | { type: 'channel-added'; channel: Channel }
  | { type: 'select-channel'; channelId: string }
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

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'channels-loaded': {
      const channels = [...action.channels].sort((a, b) => a.name.localeCompare(b.name));
      const activeChannelId =
        state.activeChannelId ??
        channels.find((c) => c.name === 'general')?.id ??
        channels[0]?.id ??
        null;
      return { ...state, channels, activeChannelId };
    }

    case 'channel-added': {
      if (state.channels.some((c) => c.id === action.channel.id)) return state;
      const channels = [...state.channels, action.channel].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      return { ...state, channels };
    }

    case 'select-channel':
      return {
        ...state,
        activeChannelId: action.channelId,
        openThreadRootId: null,
        unread: { ...state.unread, [action.channelId]: false },
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
        next = { ...next, unread: { ...next.unread, [ev.channelId]: true } };
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
