import type { Db, DbClient } from './db.js';
import type { UserRef } from './events.js';

export type CallStatus = 'ringing' | 'active' | 'ended';

export interface CallWire {
  id: string;
  channelId: string;
  initiatorId: string;
  status: CallStatus;
  startedAt: string;
  participants: UserRef[];
}

export interface CallRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  initiator_id: string;
  room: string;
  status: CallStatus;
  started_at: Date;
  ended_at: Date | null;
}

export function callWireFromRows(call: CallRow, participants: UserRef[]): CallWire {
  return {
    id: call.id,
    channelId: call.channel_id,
    initiatorId: call.initiator_id,
    status: call.status,
    startedAt: new Date(call.started_at).toISOString(),
    participants,
  };
}

export async function loadCallWire(client: Pick<Db | DbClient, 'query'>, call: CallRow): Promise<CallWire> {
  const participants = await client.query<{ id: string; handle: string; display_name: string }>(
    `SELECT u.id, u.handle, u.display_name
     FROM call_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.call_id = $1 AND cp.left_at IS NULL
     ORDER BY cp.joined_at ASC, u.handle ASC`,
    [call.id],
  );
  return callWireFromRows(
    call,
    participants.rows.map((row) => ({
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
    })),
  );
}

export async function loadCallWireById(client: DbClient, callId: string): Promise<CallWire | null> {
  const call = await client.query<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
  const row = call.rows[0];
  return row ? loadCallWire(client, row) : null;
}

export async function loadActiveCallWiresForUser(
  client: Pick<Db | DbClient, 'query'>,
  userId: string,
  opts: { channelId?: string } = {},
): Promise<CallWire[]> {
  const params: unknown[] = [userId];
  const channelFilter = opts.channelId ? 'AND c.id = $2' : '';
  if (opts.channelId) params.push(opts.channelId);
  const calls = await client.query<CallRow>(
    `SELECT calls.*
     FROM calls
     JOIN channels c ON c.id = calls.channel_id
     WHERE calls.status <> 'ended'
       ${channelFilter}
       AND CASE WHEN c.kind = 'public' THEN EXISTS (
             SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id = c.workspace_id AND wm.user_id = $1
           )
           ELSE EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = c.id AND cm.user_id = $1
           )
       END
     ORDER BY calls.started_at ASC, calls.id ASC`,
    params,
  );
  return Promise.all(calls.rows.map((call) => loadCallWire(client, call)));
}
