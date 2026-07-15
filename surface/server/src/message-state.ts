import type { DbClient } from './db.js';
import { MESSAGE_STATE_ROW_TYPES, MODIFIER_EVENT_TYPES } from './event-types.js';

export const MESSAGE_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...MODIFIER_EVENT_TYPES,
  ...MESSAGE_STATE_ROW_TYPES,
]);

export async function projectMessageEvent(client: DbClient, eventId: number): Promise<void> {
  await client.query('SELECT project_message_event($1)', [eventId]);
}

export async function refoldMessage(client: DbClient, eventId: number): Promise<void> {
  await client.query('SELECT refold_message_state($1)', [eventId]);
}
