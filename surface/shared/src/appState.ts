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
  isRenderableMessage,
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
  applySessionActivity,
  applySessionEvent,
  maxSessionStatus,
  mergeSpawnResponse,
  type Session,
  type SessionSnapshotItem,
} from './sessions';
import { mentionsUser } from './mentions';
import type { WsStatus } from './useWs';

/** 'mention' outranks plain unread — it renders as a red @ badge. */
export type UnreadLevel = false | true | 'mention';

/** Older cached channel snapshots predate archive/pin. Normalize them at the
 * reducer boundary while keeping live `Channel` entities fully typed. */
type ChannelSnapshot = Omit<Channel, 'archivedAt' | 'pinned'> & {
  archivedAt?: string | null;
  pinned?: boolean;
};

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
  /** Newest time locally saved message data was known to match the server. */
  lastSyncedAt: string | null;
  wsStatus: WsStatus;
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
  lastSyncedAt: null,
  wsStatus: 'connecting',
};

export type AppAction =
  | { type: 'init-me'; handle: string; id?: string }
  | { type: 'channels-loaded'; channels: ChannelSnapshot[] }
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
  | { type: 'channel-archive-changed'; channelId: string; archivedAt: string | null }
  | { type: 'channel-pin-changed'; channelId: string; pinned: boolean }
  | { type: 'session-pin-changed'; sessionId: string; pinned: boolean }
  | { type: 'channel-added'; channel: ChannelSnapshot }
  | { type: 'channel-removed'; channelId: string }
  | { type: 'select-channel'; channelId: string | null }
  | {
      type: 'history-loaded';
      channelId: string;
      events: WireEvent[];
      hasMore: boolean;
      nextCursor?: number;
      /** after_id used by the delta fetch; folded rows at or below it are
       * healing re-ships of OLD rows and must never insert as new rows. */
      catchupCursor?: number;
      expectedTimelineEpoch?: number;
      readCursor?: number;
      /** Per-channel after_id data must not move the workspace-wide sync cursor. */
      origin?: 'channel-delta';
    }
  | { type: 'history-reset'; channelId: string; events: WireEvent[]; hasMore: boolean; readCursor?: number }
  | { type: 'thread-loaded'; channelId: string; rootEventId: number; events: WireEvent[] }
  | { type: 'open-thread'; rootEventId: number }
  | { type: 'close-thread' }
  | { type: 'route-conversation'; threadRootId: number | null; sessionId: string | null }
  | {
      type: 'server-event';
      event: WireEvent;
      /** Catch-up cursor of the fetch that delivered this event (folded sync):
       * folded rows at or below it are healing re-ships of OLD rows and must
       * never be inserted as new timeline rows. */
      catchupCursor?: number;
    }
  | { type: 'sync-cursor'; cursor: number }
  | { type: 'last-synced-at'; at: string }
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
  | { type: 'sessions-loaded'; sessions: SessionSnapshotItem[] }
  | { type: 'session-upsert'; session: Session }
  | { type: 'session-activity'; sessionId: string; summary: string; at: string }
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

/** One order-safe merge for GET, sync snapshots, and any future snapshots. */
function mergeSessionEntity(existing: Session | undefined, incoming: Session): Session {
  const questionEvents =
    incoming.questionEvents && incoming.questionEvents.length > 0
      ? incoming.questionEvents
      : (existing?.questionEvents ?? []);
  const seatEvents = incoming.seatEvents.length > 0 ? incoming.seatEvents : (existing?.seatEvents ?? []);
  // Same shape as pendingQuestion's rule, for the same reason: a snapshot built
  // before the request landed must not erase a seat request WS already folded.
  // session.seat_changed is what clears these.
  const pendingSeatRequests =
    incoming.pendingSeatRequests.length > 0 ? incoming.pendingSeatRequests : (existing?.pendingSeatRequests ?? []);
  const session: Session = {
    ...incoming,
    // A slow snapshot must never roll back a status WS already advanced.
    status: existing ? maxSessionStatus(existing.status, incoming.status) : incoming.status,
    threadRootEventId: incoming.threadRootEventId ?? existing?.threadRootEventId ?? null,
    pendingQuestion: incoming.pendingQuestion ?? existing?.pendingQuestion ?? null,
    // The durable answered trace: a fetch that predates the answer must not
    // erase what WS already folded.
    answeredQuestion: incoming.answeredQuestion ?? existing?.answeredQuestion ?? null,
    providerAuthRequired: incoming.providerAuthRequired ?? existing?.providerAuthRequired ?? null,
    pendingSeatRequests,
    ...(existing?.latestActivity ? { latestActivity: existing.latestActivity } : {}),
    questionEvents,
    // Snapshot list rows and GET /api/sessions/:id carry no audit history, so
    // keep what live session.* folds already accumulated.
    seatEvents,
  };
  const spawnerName = incoming.spawnerName ?? existing?.spawnerName;
  const driverName = incoming.driverName ?? existing?.driverName;
  if (spawnerName !== undefined) session.spawnerName = spawnerName;
  if (driverName !== undefined) session.driverName = driverName;
  return session;
}

function sessionFromListSnapshot(state: AppState, item: SessionSnapshotItem): Session {
  const existing = state.sessions[item.id];
  return {
    ...(existing ?? {
      id: item.id,
      workspaceId: state.channels.find((channel) => channel.id === item.channelId)?.workspaceId ?? '',
      channelId: item.channelId,
      threadRootEventId: item.threadRootEventId,
      title: item.title,
      status: item.status,
      harness: item.harness,
      spawnedBy: item.spawnedBy,
      driverId: null,
      pendingSeatRequests: item.pendingSeatRequests,
      suggestions: [],
      answerProposals: [],
      pendingQuestion: item.pendingQuestion,
      providerAuthRequired: item.providerAuthRequired,
      questionEvents: [],
      seatEvents: [],
      costUsd: item.costUsd,
      resultText: item.resultText,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
      archivedAt: item.archivedAt,
      pinned: item.pinned,
      lastEventId: 0,
      permalink: `/s/${item.id}`,
    }),
    id: item.id,
    channelId: item.channelId,
    threadRootEventId: item.threadRootEventId,
    title: item.title,
    status: item.status,
    harness: item.harness,
    spawnedBy: item.spawnedBy,
    spawnerName: item.spawnerName,
    pendingQuestion: item.pendingQuestion,
    providerAuthRequired: item.providerAuthRequired,
    pendingSeatRequests: item.pendingSeatRequests,
    costUsd: item.costUsd,
    resultText: item.resultText ?? existing?.resultText ?? null,
    createdAt: item.createdAt,
    completedAt: item.completedAt ?? existing?.completedAt ?? null,
    archivedAt: item.archivedAt,
    pinned: item.pinned,
  };
}

function timelineEpoch(state: AppState, channelId: string): number {
  return state.timelineEpochs[channelId] ?? 0;
}

function remoteCursorsAfterAdvance(
  state: AppState,
  channelId: string,
  currentLastReadEventId: number,
  lastReadEventId: number,
): AppState['remoteReadCursors'] {
  return currentLastReadEventId < lastReadEventId && (state.remoteReadCursors[channelId] ?? 0) < lastReadEventId
    ? { ...state.remoteReadCursors, [channelId]: lastReadEventId }
    : state.remoteReadCursors;
}

function applyRemoteReadCursor(state: AppState, channelId: string, lastReadEventId?: number): AppState {
  if (lastReadEventId === undefined || lastReadEventId <= 0) return state;
  const currentLastReadEventId = state.channels.find((channel) => channel.id === channelId)?.lastReadEventId ?? 0;
  const channels =
    currentLastReadEventId < lastReadEventId
      ? state.channels.map((channel) => (channel.id === channelId ? { ...channel, lastReadEventId } : channel))
      : state.channels;
  const remoteReadCursors = remoteCursorsAfterAdvance(state, channelId, currentLastReadEventId, lastReadEventId);
  return channels === state.channels && remoteReadCursors === state.remoteReadCursors
    ? state
    : { ...state, channels, remoteReadCursors };
}

export function newestConfirmedMainEventId(t: ChannelTimeline | undefined): number {
  if (!t) return 0;
  for (let index = t.main.length - 1; index >= 0; index--) {
    const message = t.main[index];
    // Skip what never paints: callers compare this against a read cursor to ask
    // "has that reader seen everything here?", and a deleted trailing message
    // would answer no forever — nobody can read a row that renders nothing.
    if (message?.status === 'confirmed' && typeof message.id === 'number' && isRenderableMessage(message)) {
      return message.id;
    }
  }
  return 0;
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
      const existingChannels = new Map(state.channels.map((channel) => [channel.id, channel]));
      const channels = action.channels
        .map((channel) => {
          const existing = existingChannels.get(channel.id);
          return {
            ...channel,
            archivedAt: channel.archivedAt ?? null,
            pinned: channel.pinned ?? false,
            lastReadEventId: Math.max(channel.lastReadEventId ?? 0, existing?.lastReadEventId ?? 0),
            latestEventId: Math.max(channel.latestEventId ?? 0, existing?.latestEventId ?? 0),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const activeChannelId =
        state.activeChannelId ?? channels.find((c) => c.name === 'general')?.id ?? channels[0]?.id ?? null;
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
      const currentLastReadEventId = state.channels.find((c) => c.id === action.channelId)?.lastReadEventId ?? 0;
      const channels = state.channels.map((c) =>
        c.id === action.channelId && (c.lastReadEventId ?? 0) < action.lastReadEventId
          ? { ...c, lastReadEventId: action.lastReadEventId }
          : c,
      );
      // Track remote advances separately so a frozen unread divider can dissolve
      // when another device/tab catches up — without a local self-read moving it.
      // The server echoes your own reads to your own socket too; source-tagging
      // cannot distinguish that echo from another device, but self-reads apply
      // optimistically first, so only a cursor that advances past local state is
      // a true remote advance.
      const remoteReadCursors =
        action.source === 'remote'
          ? remoteCursorsAfterAdvance(state, action.channelId, currentLastReadEventId, action.lastReadEventId)
          : state.remoteReadCursors;
      return {
        ...state,
        channels,
        remoteReadCursors,
        unread: { ...state.unread, [action.channelId]: false },
      };
    }

    case 'mute-changed': {
      const channels = state.channels.map((c) => (c.id === action.channelId ? { ...c, muted: action.muted } : c));
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

    case 'channel-archive-changed': {
      const channels = state.channels.map((channel) =>
        channel.id === action.channelId ? { ...channel, archivedAt: action.archivedAt } : channel,
      );
      return { ...state, channels };
    }

    case 'channel-pin-changed': {
      const channels = state.channels.map((channel) =>
        channel.id === action.channelId ? { ...channel, pinned: action.pinned } : channel,
      );
      return { ...state, channels };
    }

    case 'session-pin-changed': {
      const session = state.sessions[action.sessionId];
      if (!session || session.pinned === action.pinned) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: { ...session, pinned: action.pinned },
        },
      };
    }

    case 'channel-added': {
      if (state.channels.some((c) => c.id === action.channel.id)) return state;
      const channel = {
        ...action.channel,
        archivedAt: action.channel.archivedAt ?? null,
        pinned: action.channel.pinned ?? false,
      };
      const channels = [...state.channels, channel].sort((a, b) => a.name.localeCompare(b.name));
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
        activeChannelId: state.activeChannelId === action.channelId ? null : state.activeChannelId,
        openThreadRootId: state.activeChannelId === action.channelId ? null : state.openThreadRootId,
      };
    }

    case 'select-channel':
      // null = no channel focused (mobile list screen) — unreads accrue everywhere.
      return {
        ...state,
        activeChannelId: action.channelId,
        openThreadRootId: null,
        unread: action.channelId ? { ...state.unread, [action.channelId]: false } : state.unread,
      };

    case 'history-loaded': {
      /** Apply the server cursor before folding this response's events. This
       * preserves genuinely newer unread activity without relying on caller
       * dispatch ordering, and intentionally never clears `unread`. */
      const cursorState = applyRemoteReadCursor(state, action.channelId, action.readCursor);
      if (
        action.expectedTimelineEpoch !== undefined &&
        timelineEpoch(state, action.channelId) !== action.expectedTimelineEpoch
      ) {
        return cursorState;
      }
      // An empty warm DELTA is a timeline no-op (the cursor still advances above):
      // replacing a loaded timeline over zero new evidence would churn identity.
      // An empty INITIAL load must still fold — it marks an empty channel loaded.
      if (action.events.length === 0 && action.origin === 'channel-delta') return cursorState;
      const previousTimeline = timeline(cursorState, action.channelId);
      let next = withTimeline(
        foldSessionEvents(cursorState, action.events),
        action.channelId,
        mergeHistory(previousTimeline, action.events, {
          hasMoreBefore: action.hasMore,
          ...(action.nextCursor !== undefined ? { nextCursor: action.nextCursor } : {}),
          ...(action.catchupCursor !== undefined ? { catchupCursor: action.catchupCursor } : {}),
        }),
      );
      if (action.origin !== 'channel-delta') return withSyncCursor(next, maxEventId(action.events));

      // Warm per-channel deltas run before the workspace sync/WebSocket. Fold
      // their new message activity now, but leave syncCursor at the persisted
      // workspace position so the later /sync request cannot skip unrelated
      // channel or workspace events.
      const seenIds = new Set(previousTimeline.seenIds);
      for (const ev of action.events) {
        const alreadySeen = seenIds.has(ev.id);
        seenIds.add(ev.id);
        const isNewMessage = (ev.type === 'message.posted' || ev.type === 'session.spawned') && !alreadySeen;
        if (!isNewMessage || !ev.channelId) continue;
        if (isMainTimelineVisibleEvent(ev)) {
          next = {
            ...next,
            channels: next.channels.map((channel) =>
              channel.id === ev.channelId && (channel.latestEventId ?? 0) < ev.id
                ? { ...channel, latestEventId: ev.id }
                : channel,
            ),
          };
        }
        if (ev.channelId === state.activeChannelId) continue;
        const channel = state.channels.find((candidate) => candidate.id === ev.channelId);
        if (channel?.muted) continue;
        const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
        const isDm = channel?.kind === 'dm' || channel?.kind === 'gdm';
        const mentioned =
          isDm || (ev.actorId !== null && mentionsUser(text, { id: state.meId, handle: state.meHandle }))
            ? 'mention'
            : true;
        const level = next.unread[ev.channelId] === 'mention' ? 'mention' : mentioned;
        next = { ...next, unread: { ...next.unread, [ev.channelId]: level } };
      }
      return next;
    }

    case 'history-reset': {
      /** Apply the server cursor before folding this response's events. This
       * preserves genuinely newer unread activity without relying on caller
       * dispatch ordering, and intentionally never clears `unread`. */
      const cursorState = applyRemoteReadCursor(state, action.channelId, action.readCursor);
      const next = withSyncCursor(
        withTimeline(
          foldSessionEvents(cursorState, action.events),
          action.channelId,
          resetToLatest(timeline(cursorState, action.channelId), action.events, {
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
      // A conversation can keep its attached session selected while the route
      // zooms out to the thread. The route, not reducer exclusivity, chooses
      // which mode ConversationPanel displays.
      return { ...state, openThreadRootId: action.rootEventId };

    case 'close-thread':
      return { ...state, openThreadRootId: null };

    case 'route-conversation':
      // Route re-applies fire on every location change; a no-op pair must not
      // mint a new state object (the old per-axis guards lived at call sites).
      if (
        state.openThreadRootId === action.threadRootId &&
        state.openSessionId === action.sessionId &&
        !state.openSessionError
      ) {
        return state;
      }
      return {
        ...state,
        openThreadRootId: action.threadRootId,
        openSessionId: action.sessionId,
        openSessionError: false,
      };

    case 'server-event': {
      const ev = action.event;
      const withEventCursor = (next: AppState) => withSyncCursor(next, ev.id);
      if (ev.type === 'channel.created') {
        const ch = ev.payload?.channel as Channel | undefined;
        return withEventCursor(ch ? appReducer(state, { type: 'channel-added', channel: ch }) : state);
      }
      if (ev.type === 'channel.archived' || ev.type === 'channel.unarchived') {
        const channelId = typeof ev.payload?.channelId === 'string' ? ev.payload.channelId : ev.channelId;
        if (!channelId) return withEventCursor(state);
        const archivedAt =
          ev.type === 'channel.archived'
            ? typeof ev.payload?.archivedAt === 'string'
              ? ev.payload.archivedAt
              : ev.createdAt
            : null;
        return withEventCursor(appReducer(state, { type: 'channel-archive-changed', channelId, archivedAt }));
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
        next = withTimeline(
          next,
          ev.channelId,
          applyEvent(t, ev, action.catchupCursor !== undefined ? { catchupCursor: action.catchupCursor } : {}),
        );
      }
      const isNewMessage = (ev.type === 'message.posted' || ev.type === 'session.spawned') && !alreadySeen;
      if (isNewMessage && isMainTimelineVisibleEvent(ev)) {
        // Live events must advance the cold counter — the unread divider and
        // unmute re-derivation compare latestEventId against lastReadEventId.
        next = {
          ...next,
          channels: next.channels.map((c) =>
            c.id === ev.channelId && (c.latestEventId ?? 0) < ev.id ? { ...c, latestEventId: ev.id } : c,
          ),
        };
      }
      if (isNewMessage && ev.channelId !== state.activeChannelId) {
        const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
        const channel = state.channels.find((c) => c.id === ev.channelId);
        if (channel?.muted) return withEventCursor(next);
        const isDm = channel?.kind === 'dm' || channel?.kind === 'gdm';
        const mentioned =
          isDm || (ev.actorId !== null && mentionsUser(text, { id: state.meId, handle: state.meHandle }))
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

    case 'last-synced-at':
      return { ...state, lastSyncedAt: action.at };

    case 'send-pending':
      return withTimeline(state, action.channelId, addPending(timeline(state, action.channelId), action.message));

    case 'send-failed':
      return withTimeline(state, action.channelId, markFailed(timeline(state, action.channelId), action.clientMsgId));

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
        applyLocalEditOverlay(timeline(state, action.channelId), action.opId, action.targetEventId, action.text),
      );

    case 'delete-overlay-pending':
      return withTimeline(
        state,
        action.channelId,
        applyLocalDeleteOverlay(timeline(state, action.channelId), action.opId, action.targetEventId),
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
      return withTimeline(state, action.channelId, confirmLocalOverlay(timeline(state, action.channelId), action.opId));

    case 'overlay-rejected':
      return withTimeline(state, action.channelId, rejectLocalOverlay(timeline(state, action.channelId), action.opId));

    case 'presence':
      return { ...state, presence: { ...state.presence, [action.channelId]: action.users } };

    case 'ws-status':
      return { ...state, wsStatus: action.status };

    // ---- sessions ----

    case 'session-spawn-pending':
      return {
        ...withTimeline(state, action.channelId, addPending(timeline(state, action.channelId), action.message)),
        sessions: { ...state.sessions, [action.session.id]: action.session },
      };

    case 'session-created': {
      const sessions = { ...state.sessions };
      delete sessions[action.tempId];
      sessions[action.session.id] = mergeSpawnResponse(state.sessions[action.session.id], action.session);
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
      const next = withTimeline(state, action.channelId, markFailed(timeline(state, action.channelId), action.tempId));
      const temp = next.sessions[action.tempId];
      if (!temp) return next;
      return {
        ...next,
        sessions: { ...next.sessions, [action.tempId]: { ...temp, status: 'failed' } },
      };
    }

    case 'sessions-loaded': {
      let sessions = state.sessions;
      for (const item of action.sessions) {
        if (sessions === state.sessions) sessions = { ...state.sessions };
        const incoming = sessionFromListSnapshot({ ...state, sessions }, item);
        sessions[item.id] = mergeSessionEntity(sessions[item.id], incoming);
      }
      return sessions === state.sessions ? state : { ...state, sessions };
    }

    case 'session-upsert': {
      const session = mergeSessionEntity(state.sessions[action.session.id], action.session);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.session.id]: session,
        },
      };
    }

    case 'session-activity': {
      const sessions = applySessionActivity(state.sessions, action.sessionId, {
        summary: action.summary,
        at: action.at,
      });
      return sessions === state.sessions ? state : { ...state, sessions };
    }

    case 'open-session':
      return {
        ...state,
        openSessionId: action.sessionId,
        openSessionError: false,
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
