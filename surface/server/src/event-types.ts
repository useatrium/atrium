import { CHANNEL_UNREAD_EVENT_TYPES } from '@atrium/surface-client/timeline';

export const MODIFIER_EVENT_TYPES = [
  'message.edited',
  'message.deleted',
  'message.unfurls_suppressed',
  'reaction.added',
  'reaction.removed',
] as const;

export const REPLY_EVENT_TYPES = [
  'message.posted',
  'session.replied',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
] as const;

export const MESSAGE_STATE_ROW_TYPES = [
  'message.posted',
  'voice.transcribed',
  'session.spawned',
  'session.replied',
  'session.status_changed',
  'session.effort_changed',
  'session.completed',
  'session.archived',
  'session.unarchived',
  'session.seat_requested',
  'session.seat_changed',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
  'session.provider_auth_required',
  'session.github_auth_required',
  'session.provider_auth_resolved',
] as const;

// REPLY_EVENT_TYPES plus session.spawned (a root-only type), in the historical
// SQL order. Kept explicit rather than composed — the contract test and the
// generated-SQL byte identity are the drift guards.
export const TIMELINE_ROOT_EVENT_TYPES = [
  'message.posted',
  'session.spawned',
  'session.replied',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
] as const;

// Keep the historical SQL ordering. MODIFIER_EVENT_TYPES deliberately orders
// message.deleted before message.unfurls_suppressed, while this list did not.
export const TIMELINE_EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.unfurls_suppressed',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'voice.transcribed',
  'session.spawned',
  'session.replied',
  'session.status_changed',
  'session.effort_changed',
  'session.completed',
  'session.archived',
  'session.unarchived',
  'session.seat_requested',
  'session.seat_changed',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
  'session.provider_auth_required',
  'session.github_auth_required',
  'session.provider_auth_resolved',
] as const;

export const SYNC_EVENT_TYPES = [
  ...TIMELINE_EVENT_TYPES,
  'channel.created',
  'channel.archived',
  'channel.unarchived',
  'channel.member_joined',
  'channel.member_left',
  'call.ended',
] as const;

export function sqlTypeList(types: readonly string[]): string {
  return `(${types.map((type) => `'${type.replaceAll("'", "''")}'`).join(', ')})`;
}

// === fold15-server additions ===

const CATCHUP_FOLDED_EVENT_TYPES = new Set<string>([...MODIFIER_EVENT_TYPES, ...TIMELINE_ROOT_EVENT_TYPES]);

export const CATCHUP_RAW_EVENT_TYPES = TIMELINE_EVENT_TYPES.filter((type) => !CATCHUP_FOLDED_EVENT_TYPES.has(type));

const TIMELINE_EVENT_TYPE_SET = new Set<string>(TIMELINE_EVENT_TYPES);

export const SYNC_CATCHUP_RAW_EVENT_TYPES = [
  ...CATCHUP_RAW_EVENT_TYPES,
  ...SYNC_EVENT_TYPES.filter((type) => !TIMELINE_EVENT_TYPE_SET.has(type)),
];

/**
 * Per-channel `latest_event_id` — the newest event that should draw attention.
 * Correlates against `c.id`, so it belongs inside a LATERAL over `channels c`.
 *
 * ONE definition on purpose. This rule lived as two copies (the channel list and
 * the push badge) and they silently drifted: the badge never grew the broadcast
 * clause, so it counted thread replies nobody could see in the feed.
 *
 * Deleted messages are excluded. The content is gone, so it must not light a
 * channel — and a deleted message with no replies left renders no row at all,
 * which made this counter unreachable: it named an id the client could never
 * scroll to, so mark-read could never catch up and the channel stayed unread
 * forever. Whatever id this returns, a client must be able to see and read it.
 */
export const CHANNEL_LATEST_EVENT_ID_SQL = `
       SELECT MAX(e.id) AS latest_event_id
       FROM events e
       LEFT JOIN message_state ms ON ms.event_id = e.id
       WHERE e.channel_id = c.id
         AND e.type IN ${sqlTypeList(CHANNEL_UNREAD_EVENT_TYPES)}
         AND (e.thread_root_event_id IS NULL OR (e.payload->>'broadcast')::boolean IS TRUE)
         AND NOT COALESCE(ms.is_deleted, false)`;
