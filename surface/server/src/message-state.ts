import type { DbClient } from './db.js';

// Keep this list aligned with the message modifiers and TIMELINE_EVENT_TYPES
// classifier in events.ts / project_message_event(bigint).
export const MESSAGE_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
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
]);

export async function projectMessageEvent(client: DbClient, eventId: number): Promise<void> {
  await client.query('SELECT project_message_event($1)', [eventId]);
}

export async function refoldMessage(client: DbClient, eventId: number): Promise<void> {
  await client.query('SELECT refold_message_state($1)', [eventId]);
}
