import type { Channel } from './api';
import type { AppAction } from './appState';
import type { DraftDeletionSnapshot, DraftSnapshot } from './drafts';
import { normalizePrefs, type UserPrefs } from './prefs';
import type { WireEvent } from './timeline';

export interface SyncStateSnapshot {
  readCursors: Record<string, number>;
  mutes: string[];
  prefs: UserPrefs;
  drafts: DraftSnapshot;
  draftDeletions: DraftDeletionSnapshot;
  channels: Channel[];
}

export interface SyncResponse {
  events: WireEvent[];
  nextCursor: number;
  limited: boolean;
  state: SyncStateSnapshot;
}

export type AppDispatch = (action: AppAction) => void;

export function dispatchSyncSnapshot(
  dispatch: AppDispatch,
  snapshot: SyncStateSnapshot,
  onPrefs?: (prefs: UserPrefs) => void,
): void {
  dispatch({ type: 'channels-loaded', channels: snapshot.channels });
  for (const [channelId, lastReadEventId] of Object.entries(snapshot.readCursors)) {
    dispatch({ type: 'read-cursor', channelId, lastReadEventId });
  }
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
  } = {},
): void {
  for (const event of response.events) {
    opts.onEvent?.(event);
    dispatch({ type: 'server-event', event });
  }
  dispatchSyncSnapshot(dispatch, response.state, opts.onPrefs);
  dispatch({ type: 'sync-cursor', cursor: response.nextCursor });
}
