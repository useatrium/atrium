import type { ActivityItem } from './api.js';

/** Filters for the Attention inbox surface. */
export type ActivityFeedFilter = 'inbox' | 'unread' | 'done' | 'all';
export type ActivitySourceFilter = 'all' | 'agents' | 'people';

const AGENT_ACTIVITY_KINDS = new Set<ActivityItem['kind']>([
  'agent_question',
  'agent_auth',
  'session_completed',
  'session_failed',
]);

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

  // Normalize both Set and array inputs so callers can pass either cheaply.
  const exceptions: ReadonlySet<string> =
    unreadExceptionIds instanceof Set
      ? unreadExceptionIds
      : new Set(Array.from(unreadExceptionIds as readonly string[], String));
  if (exceptions.has(String(item.eventId))) return true;

  const eventId = Number(item.eventId);
  const watermark = Number(lastReadEventId);
  return Number.isSafeInteger(eventId) && Number.isSafeInteger(watermark) && eventId > watermark;
}

/** Inbox keeps ordinary activity plus unread terminal outcomes; Reviewed is read terminal work. */
export function matchesActivityFilter(item: ActivityItem, filter: ActivityFeedFilter, unread: boolean): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return !unread && (item.kind === 'session_completed' || item.kind === 'session_failed');
  if (filter === 'unread') return unread;
  // Finished work remains actionable only until it has been reviewed.
  return !['session_completed', 'session_failed'].includes(item.kind) || unread;
}

/** Source chips compose with every inbox tab. */
export function matchesActivitySource(item: ActivityItem, source: ActivitySourceFilter): boolean {
  if (source === 'all') return true;
  const agentActivity = AGENT_ACTIVITY_KINDS.has(item.kind);
  return source === 'agents' ? agentActivity : !agentActivity;
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
