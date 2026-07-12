import type { ActivityItem } from './api.js';

/** Filters for the Attention inbox surface. */
export type ActivityFeedFilter = 'inbox' | 'unread' | 'done' | 'all';

/**
 * Unread = above the watermark, or in the mark-unread exception set.
 * Muted rows never count as unread.
 */
export function isActivityUnread(
  item: Pick<ActivityItem, 'eventId' | 'muted' | 'unread'>,
  lastReadEventId: string,
  unreadExceptionIds: ReadonlySet<string> | readonly string[] = [],
): boolean {
  if (item.muted) return false;
  // Prefer server-computed flag when present (includes exception math).
  if (typeof item.unread === 'boolean') return item.unread;

  const exceptions =
    unreadExceptionIds instanceof Set ? unreadExceptionIds : new Set(unreadExceptionIds.map(String));
  if (exceptions.has(String(item.eventId))) return true;

  const eventId = Number(item.eventId);
  const watermark = Number(lastReadEventId);
  return Number.isSafeInteger(eventId) && Number.isSafeInteger(watermark) && eventId > watermark;
}

/** Default Inbox hides completions; Done is completions-only; Unread is any unread. */
export function matchesActivityFilter(item: ActivityItem, filter: ActivityFeedFilter, unread: boolean): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return item.kind === 'session_completed';
  if (filter === 'unread') return unread;
  // inbox: everything except completed sessions
  return item.kind !== 'session_completed';
}

export function activityKindMarker(kind: ActivityItem['kind']): string {
  switch (kind) {
    case 'mention':
      return '@';
    case 'dm':
      return 'DM';
    case 'thread_reply':
      return '↩';
    case 'agent_question':
      return '?';
    case 'session_completed':
      return '✓';
    case 'session_failed':
      return '!';
    case 'agent_auth':
      return '⚿';
    case 'reaction':
      return '☺';
    case 'channel_invite':
      return '+';
    case 'seat_request':
      return '⇄';
    case 'missed_call':
    case 'call_declined':
      return '✆';
    default:
      return '•';
  }
}
