import { CALL_MAX_AGE_MS, CALL_RING_TTL_MS } from '@atrium/surface-client/calls';
import type { Db, DbClient } from './db.js';
import type { UserRef } from './events.js';
import { workspaceMemberIds } from './membership.js';

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

export interface EndCallResult {
  callId: string;
  recipients: string[];
  ended: boolean;
}

export type ActiveCallRow = CallRow & { channel_kind: 'public' | 'private' | 'dm' | 'gdm' };

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

export async function channelRecipientIds(client: DbClient, channelId: string): Promise<string[]> {
  const channel = await client.query<{ workspace_id: string; kind: string }>(
    'SELECT workspace_id, kind FROM channels WHERE id = $1',
    [channelId],
  );
  const row = channel.rows[0];
  if (!row) return [];
  if (row.kind === 'public') {
    return workspaceMemberIds(client, row.workspace_id);
  }
  const members = await client.query<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = $1', [
    channelId,
  ]);
  return members.rows.map((member) => member.user_id);
}

export async function activeCallById(client: DbClient, callId: string): Promise<ActiveCallRow | null> {
  const call = await client.query<ActiveCallRow>(
    `SELECT calls.*, c.kind AS channel_kind
     FROM calls
     JOIN channels c ON c.id = calls.channel_id
     WHERE calls.id = $1 AND calls.status <> 'ended'
     FOR UPDATE OF calls`,
    [callId],
  );
  return call.rows[0] ?? null;
}

/** End a live call while holding its row lock and collect its channel recipients. */
export async function endCall(client: DbClient, callId: string): Promise<EndCallResult | null> {
  const call = await activeCallById(client, callId);
  if (!call) return null;
  await client.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [call.id]);
  const ended = await client.query(
    `UPDATE calls
     SET status = 'ended', ended_at = COALESCE(ended_at, now())
     WHERE id = $1 AND status <> 'ended'
     RETURNING 1`,
    [call.id],
  );
  if ((ended.rowCount ?? 0) === 0) {
    return { callId: call.id, recipients: [], ended: false };
  }
  return {
    callId: call.id,
    recipients: await channelRecipientIds(client, call.channel_id),
    ended: true,
  };
}

export async function loadActiveCallWiresForUser(
  client: Pick<Db | DbClient, 'query'>,
  userId: string,
  opts: { channelId?: string } = {},
): Promise<CallWire[]> {
  const params: unknown[] = [userId, CALL_RING_TTL_MS, CALL_MAX_AGE_MS];
  const channelFilter = opts.channelId ? 'AND c.id = $4' : '';
  if (opts.channelId) params.push(opts.channelId);
  const calls = await client.query<CallRow>(
    `SELECT calls.*
     FROM calls
     JOIN channels c ON c.id = calls.channel_id
     WHERE calls.status <> 'ended'
       AND calls.started_at >= now() - ($3::double precision * interval '1 millisecond')
       AND (
         calls.status <> 'ringing'
         OR calls.started_at >= now() - ($2::double precision * interval '1 millisecond')
       )
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
