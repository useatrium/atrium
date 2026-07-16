import { Schema } from 'effect';
import type { Channel } from './api';
import type { AppAction } from './appState';
import type { DraftDeletionSnapshot, DraftSnapshot } from './drafts';
import { normalizePrefs, UserPrefsSchema, type UserPrefs } from './prefs';
import { SessionSnapshotItemSchema, type SessionSnapshotItem } from './sessions';
import { UserRefSchema, WireEventSchema, type WireEvent } from './timeline';

const ChannelKindSchema = Schema.Literal('public', 'private', 'dm', 'gdm');
const NullableStringSchema = Schema.Union(Schema.String, Schema.Null);

export const ChannelSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    workspaceId: Schema.String,
    name: Schema.String,
    createdAt: Schema.String,
    // Decode-with-default: an old server (deploy skew) or cached snapshot may
    // omit these; failing the whole channel-list decode would blank the sidebar.
    archivedAt: Schema.optionalWith(NullableStringSchema, { default: () => null }),
    pinned: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    lastReadEventId: Schema.optionalWith(Schema.Number, { exact: true }),
    latestEventId: Schema.optionalWith(Schema.Number, { exact: true }),
    muted: Schema.optionalWith(Schema.Boolean, { exact: true }),
    mentionedSinceRead: Schema.optionalWith(Schema.Boolean, { exact: true }),
    kind: Schema.optionalWith(ChannelKindSchema, { exact: true }),
    members: Schema.optionalWith(Schema.mutable(Schema.Array(UserRefSchema)), { exact: true }),
    memberCount: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
);

const DraftSnapshotEntrySchema = Schema.mutable(
  Schema.Struct({
    text: Schema.String,
    updatedAt: Schema.String,
    // Decode-with-default: pre-076 servers (and cached snapshots) omit it. A
    // missing flag means "ordinary chat draft", which is the safe reading.
    agentIntent: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  }),
);

export const SyncStateSnapshotSchema = Schema.mutable(
  Schema.Struct({
    readCursors: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Number })),
    mutes: Schema.mutable(Schema.Array(Schema.String)),
    prefs: UserPrefsSchema,
    drafts: Schema.mutable(Schema.Record({ key: Schema.String, value: DraftSnapshotEntrySchema })),
    draftDeletions: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
    channels: Schema.mutable(Schema.Array(ChannelSchema)),
    // Decode-with-default for rolling deploys where the client arrives before
    // the server starts shipping session snapshot rows.
    sessions: Schema.optionalWith(Schema.mutable(Schema.Array(SessionSnapshotItemSchema)), { default: () => [] }),
  }),
);

export interface SyncStateSnapshot {
  readCursors: Record<string, number>;
  mutes: string[];
  prefs: UserPrefs;
  drafts: DraftSnapshot;
  draftDeletions: DraftDeletionSnapshot;
  channels: Channel[];
  sessions: SessionSnapshotItem[];
}

export interface SyncResponse {
  events: WireEvent[];
  nextCursor: number;
  limited: boolean;
  state: SyncStateSnapshot;
}

export const SyncResponseSchema = Schema.mutable(
  Schema.Struct({
    events: Schema.mutable(Schema.Array(WireEventSchema)),
    nextCursor: Schema.Number,
    limited: Schema.Boolean,
    state: SyncStateSnapshotSchema,
  }),
);

export type AppDispatch = (action: AppAction) => void;

export function dispatchSyncSnapshot(
  dispatch: AppDispatch,
  snapshot: SyncStateSnapshot,
  onPrefs?: (prefs: UserPrefs) => void,
): void {
  for (const [channelId, lastReadEventId] of Object.entries(snapshot.readCursors)) {
    // A sync snapshot is server truth, which may reflect a read from another
    // device/tab — mark it remote so a frozen divider can dissolve on catch-up.
    // Keep cursor dispatches first for a predictable snapshot fold. Cursor
    // correctness is order-safe: channels-loaded merges counters monotonically.
    dispatch({ type: 'read-cursor', channelId, lastReadEventId, source: 'remote' });
  }
  dispatch({ type: 'channels-loaded', channels: snapshot.channels });
  dispatch({ type: 'sessions-loaded', sessions: snapshot.sessions });
  const muted = new Set(snapshot.mutes);
  for (const channel of snapshot.channels) {
    dispatch({ type: 'mute-changed', channelId: channel.id, muted: muted.has(channel.id) });
  }
  onPrefs?.(normalizePrefs(snapshot.prefs));
}

export function dispatchSyncResponse(
  dispatch: AppDispatch,
  response: SyncResponse,
  opts: {
    onPrefs?: (prefs: UserPrefs) => void;
    onEvent?: (event: WireEvent) => void;
    /** The `after` cursor this sync was fetched with. Folded rows at or below
     * it are healing re-ships of OLD rows and must never insert as new rows. */
    catchupCursor?: number;
  } = {},
): void {
  for (const event of response.events) {
    opts.onEvent?.(event);
    dispatch({
      type: 'server-event',
      event,
      ...(opts.catchupCursor !== undefined ? { catchupCursor: opts.catchupCursor } : {}),
    });
  }
  dispatchSyncSnapshot(dispatch, response.state, opts.onPrefs);
  dispatch({ type: 'sync-cursor', cursor: response.nextCursor });
}
