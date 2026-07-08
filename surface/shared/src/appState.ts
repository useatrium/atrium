// App-level reducer: thin glue around the pure timeline functions in state.ts.

import type { Channel } from './api';
import {
  addPending,
  applyLocalDeleteOverlay,
  applyLocalEditOverlay,
  applyLocalReactionOverlay,
  applyEvent,
  confirmLocalOverlay,
  emptyTimeline,
  markFailed,
  mergeHistory,
  resetToLatest,
  mergeThread,
  removeByClientMsgId,
  rejectLocalOverlay,
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
  timelineEpochs: Record<string, number>;
  presence: Record<string, UserRef[]>;
  /** Session entities by id (incl. optimistic `pending:*` ids until POST resolves). */
  sessions: Record<string, Session>;
  activeChannelId: string | null;
  openThreadRootId: number | null;
  openSessionId: string | null;
  /** The open pane's session couldn't be fetched (bad permalink, deleted). */
  openSessionError: boolean;
  unread: Record<string, UnreadLevel>;
  /**
   * Read cursors advanced by a REMOTE source — another device or browser tab of
   * the same user, learned via the WS `read` event or a sync snapshot. Used to
   * dissolve a frozen unread divider when you catch up elsewhere while viewing a
   * channel here. Not persisted; rebuilt per session from onRead/sync.
   */
  remoteReadCursors: Record<string, number>;
  /** Current user's handle — drives @mention unread detection. */
  meHandle: string | null;
  meId: string | null;
  /** Max workspace event id applied through history, sync, WS, or POST echoes. */
  syncCursor: number;
  wsStatus: 'connecting' | 'open' | 'closed';
}

export const initialAppState: AppState = {
  channels: [],
  timelines: {},
  timelineEpochs: {},
  presence: {},
  sessions: {},
  activeChannelId: null,
  openThreadRootId: null,
  openSessionId: null,
  openSessionError: false,
  unread: {},
  remoteReadCursors: {},
  meHandle: null,
  meId: null,
  syncCursor: 0,
  wsStatus: 'connecting',
};

export type AppAction =
  | { type: 'init-me'; handle: string; id?: string }
  | { type: 'channels-loaded'; channels: Channel[] }
  | {
      type: 'read-cursor';
      channelId: string;
      lastReadEventId: number;
      /**
       * Where the advance came from. 'self' (default) = this client read; only
       * bumps the channel's own cursor. 'remote' = another device/tab of the same
       * user (WS `read` / sync) — additionally tracked in `remoteReadCursors` so a
       * frozen divider can dissolve without a self-read moving it.
       */
      source?: 'self' | 'remote';
    }
  | { type: 'mute-changed'; channelId: string; muted: boolean }
  | { type: 'channel-added'; channel: Channel }
  | { type: 'channel-removed'; channelId: string }
  | { type: 'select-channel'; channelId: string | null }
  | {
      type: 'history-loaded';
      channelId: string;
      events: WireEvent[];
      hasMore: boolean;
      expectedTimelineEpoch?: number;
    }
  | { type: 'history-reset'; channelId: string; events: WireEvent[]; hasMore: boolean }
  | { type: 'thread-loaded'; channelId: string; rootEventId: number; events: WireEvent[] }
  | { type: 'open-thread'; rootEventId: number }
  | { type: 'close-thread' }
  | { type: 'server-event'; event: WireEvent }
  | { type: 'sync-cursor'; cursor: number }
  | { type: 'send-pending'; channelId: string; message: ChatMessage }
  | { type: 'send-failed'; channelId: string; clientMsgId: string }
  | { type: 'retry-remove'; channelId: string; clientMsgId: string }
  | {
      type: 'edit-overlay-pending';
      channelId: string;
      opId: string;
      targetEventId: number;
      text: string;
    }
  | { type: 'delete-overlay-pending'; channelId: string; opId: string; targetEventId: number }
  | {
      type: 'reaction-overlay-pending';
      channelId: string;
      opId: string;
      targetEventId: number;
      emoji: string;
      userId: string;
      action: 'add' | 'remove';
    }
  | { type: 'overlay-confirmed'; channelId: string; opId: string }
  | { type: 'overlay-rejected'; channelId: string; opId: string }
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

function maxEventId(events: WireEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id), 0);
}

function withSyncCursor(state: AppState, cursor: number): AppState {
  return cursor > state.syncCursor ? { ...state, syncCursor: cursor } : state;
}

function timelineEpoch(state: AppState, channelId: string): number {
  return state.timelineEpochs[channelId] ?? 0;
}

/** Does `text` @-mention the user? Handles are [a-z0-9_-], so no escaping. */
export function mentionsHandle(text: string, handle: string | null): boolean {
  if (!handle) return false;
  return new RegExp(`@${handle}(?![a-z0-9_-])`, 'i').test(text);
}

// === mentions-activity additions ===
function coldUnreadLevel(ch: Channel): UnreadLevel {
  const latest = ch.latestEventId ?? 0;
  const lastRead = ch.lastReadEventId ?? 0;
  if (latest <= lastRead) return false;
  const isDm = ch.kind === 'dm' || ch.kind === 'gdm';
  return ch.mentionedSinceRead || isDm ? 'mention' : true;
}

function isMainTimelineVisibleEvent(ev: WireEvent): boolean {
  return ev.threadRootEventId == null || ev.broadcast === true || ev.payload?.broadcast === true;
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
        // === mentions-activity additions ===
        const level = coldUnreadLevel(ch);
        if (unread[ch.id] !== level) unread = { ...unread, [ch.id]: level };
      }
      return { ...state, channels, activeChannelId, unread };
    }

    case 'read-cursor': {
      // Keep the cold counter current too — the unread divider and unmute
      // re-derivation compare against it long after channels-loaded.
      const channels = state.channels.map((c) =>
        c.id === action.channelId && (c.lastReadEventId ?? 0) < action.lastReadEventId
          ? { ...c, lastReadEventId: action.lastReadEventId }
          : c,
      );
      // Track remote advances separately so a frozen unread divider can dissolve
      // when another device/tab catches up — without a local self-read moving it.
      const remoteReadCursors =
        action.source === 'remote' &&
        (state.remoteReadCursors[action.channelId] ?? 0) < action.lastReadEventId
          ? { ...state.remoteReadCursors, [action.channelId]: action.lastReadEventId }
          : state.remoteReadCursors;
      return {
        ...state,
        channels,
        remoteReadCursors,
        unread: { ...state.unread, [action.channelId]: false },
      };
    }

    case 'mute-changed': {
      const channels = state.channels.map((c) =>
        c.id === action.channelId ? { ...c, muted: action.muted } : c,
      );
      let level: UnreadLevel = false;
      if (!action.muted) {
        // Unmuting re-derives unread from the cold counters — messages that
        // arrived while muted were suppressed by the server-event fold.
        const ch = channels.find((c) => c.id === action.channelId);
        // === mentions-activity additions ===
        level = ch ? coldUnreadLevel(ch) : false;
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
      const timelineEpochs = { ...state.timelineEpochs };
      const presence = { ...state.presence };
      const unread = { ...state.unread };
      delete timelines[action.channelId];
      delete timelineEpochs[action.channelId];
      delete presence[action.channelId];
      delete unread[action.channelId];
      return {
        ...state,
        channels: state.channels.filter((c) => c.id !== action.channelId),
        timelines,
        timelineEpochs,
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
      if (
        action.expectedTimelineEpoch !== undefined &&
        timelineEpoch(state, action.channelId) !== action.expectedTimelineEpoch
      ) {
        return state;
      }
      return withSyncCursor(
        withTimeline(
          foldSessionEvents(state, action.events),
          action.channelId,
          mergeHistory(timeline(state, action.channelId), action.events, {
            hasMoreBefore: action.hasMore,
          }),
        ),
        maxEventId(action.events),
      );

    case 'history-reset': {
      const next = withSyncCursor(
        withTimeline(
          foldSessionEvents(state, action.events),
          action.channelId,
          resetToLatest(timeline(state, action.channelId), action.events, {
            hasMoreBefore: action.hasMore,
          }),
        ),
        maxEventId(action.events),
      );
      return {
        ...next,
        timelineEpochs: {
          ...next.timelineEpochs,
          [action.channelId]: timelineEpoch(state, action.channelId) + 1,
        },
      };
    }

    case 'thread-loaded':
      return withSyncCursor(
        withTimeline(
          foldSessionEvents(state, action.events),
          action.channelId,
          mergeThread(timeline(state, action.channelId), action.rootEventId, action.events),
        ),
        maxEventId(action.events),
      );

    case 'open-thread':
      return { ...state, openThreadRootId: action.rootEventId, openSessionId: null };

    case 'close-thread':
      return { ...state, openThreadRootId: null };

    case 'server-event': {
      const ev = action.event;
      const withEventCursor = (next: AppState) =>
        ev.mock ? next : withSyncCursor(next, ev.id);
      if (ev.type === 'channel.created') {
        const ch = ev.payload?.channel as Channel | undefined;
        return withEventCursor(ch ? appReducer(state, { type: 'channel-added', channel: ch }) : state);
      }
      if (ev.type === 'channel.member_left' && ev.payload?.userId === state.meId) {
        return withEventCursor(
          ev.channelId ? appReducer(state, { type: 'channel-removed', channelId: ev.channelId }) : state,
        );
      }
      let next = state;
      if (ev.type.startsWith('session.')) {
        const sessions = applySessionEvent(state.sessions, ev);
        if (sessions !== state.sessions) next = { ...next, sessions };
      }
      if (!ev.channelId) return withEventCursor(next);
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
      if (isNewMessage && isMainTimelineVisibleEvent(ev) && !ev.mock && typeof ev.id === 'number') {
        // Live events must advance the cold counter — the unread divider and
        // unmute re-derivation compare latestEventId against lastReadEventId.
        next = {
          ...next,
          channels: next.channels.map((c) =>
            c.id === ev.channelId && (c.latestEventId ?? 0) < ev.id
              ? { ...c, latestEventId: ev.id }
              : c,
          ),
        };
      }
      if (isNewMessage && ev.channelId !== state.activeChannelId) {
        const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
        const channel = state.channels.find((c) => c.id === ev.channelId);
        if (channel?.muted) return withEventCursor(next);
        const isDm = channel?.kind === 'dm' || channel?.kind === 'gdm';
        const mentioned =
          isDm || (ev.actorId !== null && mentionsHandle(text, state.meHandle))
            ? 'mention'
            : true;
        // A mention badge sticks until the channel is read.
        const level = next.unread[ev.channelId] === 'mention' ? 'mention' : mentioned;
        next = { ...next, unread: { ...next.unread, [ev.channelId]: level } };
      }
      return withEventCursor(next);
    }

    case 'sync-cursor':
      return withSyncCursor(state, action.cursor);

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

    case 'edit-overlay-pending':
      return withTimeline(
        state,
        action.channelId,
        applyLocalEditOverlay(
          timeline(state, action.channelId),
          action.opId,
          action.targetEventId,
          action.text,
        ),
      );

    case 'delete-overlay-pending':
      return withTimeline(
        state,
        action.channelId,
        applyLocalDeleteOverlay(
          timeline(state, action.channelId),
          action.opId,
          action.targetEventId,
        ),
      );

    case 'reaction-overlay-pending':
      return withTimeline(
        state,
        action.channelId,
        applyLocalReactionOverlay(
          timeline(state, action.channelId),
          action.opId,
          action.targetEventId,
          action.emoji,
          action.userId,
          action.action,
        ),
      );

    case 'overlay-confirmed':
      return withTimeline(
        state,
        action.channelId,
        confirmLocalOverlay(timeline(state, action.channelId), action.opId),
      );

    case 'overlay-rejected':
      return withTimeline(
        state,
        action.channelId,
        rejectLocalOverlay(timeline(state, action.channelId), action.opId),
      );

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
      const questionEvents =
        action.session.questionEvents && action.session.questionEvents.length > 0
          ? action.session.questionEvents
          : existing?.questionEvents ?? [];
      const seatEvents =
        action.session.seatEvents.length > 0
          ? action.session.seatEvents
          : existing?.seatEvents ?? [];
      const session: Session = {
        ...action.session,
        // A slow GET must never roll back a status WS already advanced.
        status: existing
          ? maxSessionStatus(existing.status, action.session.status)
          : action.session.status,
        pendingQuestion: action.session.pendingQuestion ?? existing?.pendingQuestion ?? null,
        providerAuthRequired:
          action.session.providerAuthRequired ?? existing?.providerAuthRequired ?? null,
        questionEvents,
        // GET /api/sessions/:id carries no audit history, so keep what
        // live session.* folds already accumulated.
        seatEvents,
      };
      const spawnerName = action.session.spawnerName ?? existing?.spawnerName;
      const driverName = action.session.driverName ?? existing?.driverName;
      if (spawnerName !== undefined) session.spawnerName = spawnerName;
      if (driverName !== undefined) session.driverName = driverName;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.session.id]: session,
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
