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
  type ChannelTimeline,
  type ChatMessage,
  type UserRef,
  type WireEvent,
} from './state';

export interface AppState {
  channels: Channel[];
  timelines: Record<string, ChannelTimeline>;
  presence: Record<string, UserRef[]>;
  activeChannelId: string | null;
  openThreadRootId: number | null;
  unread: Record<string, boolean>;
  wsStatus: 'connecting' | 'open' | 'closed';
}

export const initialAppState: AppState = {
  channels: [],
  timelines: {},
  presence: {},
  activeChannelId: null,
  openThreadRootId: null,
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
  | { type: 'ws-status'; status: AppState['wsStatus'] };

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
        state,
        action.channelId,
        mergeHistory(timeline(state, action.channelId), action.events, {
          hasMoreBefore: action.hasMore,
        }),
      );

    case 'thread-loaded':
      return withTimeline(
        state,
        action.channelId,
        mergeThread(timeline(state, action.channelId), action.rootEventId, action.events),
      );

    case 'open-thread':
      return { ...state, openThreadRootId: action.rootEventId };

    case 'close-thread':
      return { ...state, openThreadRootId: null };

    case 'server-event': {
      const ev = action.event;
      if (ev.type === 'channel.created') {
        const ch = ev.payload?.channel as Channel | undefined;
        return ch ? appReducer(state, { type: 'channel-added', channel: ch }) : state;
      }
      if (!ev.channelId) return state;
      const t = timeline(state, ev.channelId);
      // Only fold message events into channels we've actually loaded; untouched
      // channels fetch their history on first open. But always track unread.
      const alreadySeen = t.seenIds.has(ev.id);
      let next = state;
      if (t.loaded || t.main.length > 0) {
        next = withTimeline(state, ev.channelId, applyEvent(t, ev));
      }
      const isNewMessage = ev.type === 'message.posted' && !alreadySeen;
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

    case 'retry-remove':
      return withTimeline(
        state,
        action.channelId,
        removeByClientMsgId(timeline(state, action.channelId), action.clientMsgId),
      );

    case 'presence':
      return { ...state, presence: { ...state.presence, [action.channelId]: action.users } };

    case 'ws-status':
      return { ...state, wsStatus: action.status };

    default:
      return state;
  }
}
