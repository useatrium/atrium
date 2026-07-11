import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ActiveCallsQuerySchema,
  CallIdParamsSchema,
  StartCallBodySchema,
} from '@atrium/surface-client/calls';
import type { AppMutationContext } from '../app-mutations.js';
import type { Db, DbClient } from '../db.js';
import { withTx } from '../db.js';
import { loadActiveCallWiresForUser, loadCallWire, type CallRow } from '../calls.js';
import { canAccessChannel, DomainError, type UserRef } from '../events.js';
import type { WsHub } from '../hub.js';
import { createLiveKitWebhookReceiver, type CallTokenService } from '../livekit.js';
import { workspaceMemberExists, workspaceMemberIds } from '../membership.js';
import { sendIncomingCallVoipPushes, type VoipPushSender } from '../voip.js';
import { isUuid } from '../idempotency.js';
import { decodeRouteBody, decodeRouteParams, decodeRouteQuery } from '../route-schema.js';

export interface CallRouteDeps extends AppMutationContext {
  pool: Db;
  hub: WsHub;
  calls: CallTokenService | null;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  voip: VoipPushSender;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function callsUnconfigured(reply: FastifyReply) {
  return reply
    .code(503)
    .send({ error: 'calls_unconfigured', message: 'voice calls are not configured' });
}

async function channelRecipientIds(client: DbClient, channelId: string): Promise<string[]> {
  const channel = await client.query<{ workspace_id: string; kind: string }>(
    'SELECT workspace_id, kind FROM channels WHERE id = $1',
    [channelId],
  );
  const row = channel.rows[0];
  if (!row) return [];
  if (row.kind === 'public') {
    return workspaceMemberIds(client, row.workspace_id);
  }
  const members = await client.query<{ user_id: string }>(
    'SELECT user_id FROM channel_members WHERE channel_id = $1',
    [channelId],
  );
  return members.rows.map((member) => member.user_id);
}

async function canAccessChannelInTx(
  client: DbClient,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const res = await client.query<{ member: boolean }>(
    `SELECT CASE WHEN c.kind = 'public' THEN ${workspaceMemberExists('c.workspace_id', '$2')}
                 ELSE EXISTS (SELECT 1 FROM channel_members m
                              WHERE m.channel_id = c.id AND m.user_id = $2)
            END AS member
     FROM channels c WHERE c.id = $1`,
    [channelId, userId],
  );
  return res.rows[0]?.member === true;
}

async function activeCallById(
  client: DbClient,
  callId: string,
): Promise<(CallRow & { channel_kind: 'public' | 'private' | 'dm' | 'gdm' }) | null> {
  const call = await client.query<CallRow & { channel_kind: 'public' | 'private' | 'dm' | 'gdm' }>(
    `SELECT calls.*, c.kind AS channel_kind
     FROM calls
     JOIN channels c ON c.id = calls.channel_id
     WHERE calls.id = $1 AND calls.status <> 'ended'
     FOR UPDATE OF calls`,
    [callId],
  );
  return call.rows[0] ?? null;
}

interface ParticipantLeftResult {
  callId: string;
  recipients: string[];
  ended: boolean;
  left: boolean;
}

interface EndCallResult {
  callId: string;
  recipients: string[];
  ended: boolean;
}

type LiveKitWebhookEvent = {
  event?: string;
  room?: { name?: string };
  participant?: { identity?: string };
};

type LiveKitWebhookResult =
  | { type: 'participant_left'; result: ParticipantLeftResult }
  | { type: 'room_finished'; result: EndCallResult };

function callIdFromLiveKitRoom(roomName: string | undefined): string | null {
  if (!roomName?.startsWith('call:')) return null;
  const callId = roomName.slice('call:'.length);
  return isUuid(callId) ? callId : null;
}

async function markParticipantLeftInCall(
  client: DbClient,
  call: Pick<CallRow, 'id' | 'channel_id'>,
  userId: string,
): Promise<ParticipantLeftResult> {
  const left = await client.query(
    `UPDATE call_participants
     SET left_at = now()
     WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL
     RETURNING 1`,
    [call.id, userId],
  );
  // Not an active participant (never joined / already left): no-op, no signal.
  if ((left.rowCount ?? 0) === 0) {
    return { callId: call.id, recipients: [], ended: false, left: false };
  }
  const remaining = await client.query<{ count: string }>(
    'SELECT COUNT(*) FROM call_participants WHERE call_id = $1 AND left_at IS NULL',
    [call.id],
  );
  const shouldEnd = Number(remaining.rows[0]!.count) === 0;
  let ended = false;
  if (shouldEnd) {
    const updated = await client.query(
      `UPDATE calls
       SET status = 'ended', ended_at = COALESCE(ended_at, now())
       WHERE id = $1 AND status <> 'ended'
       RETURNING 1`,
      [call.id],
    );
    ended = (updated.rowCount ?? 0) > 0;
  }
  return {
    callId: call.id,
    recipients: await channelRecipientIds(client, call.channel_id),
    ended,
    left: true,
  };
}

async function markParticipantLeft(
  client: DbClient,
  callId: string,
  userId: string,
): Promise<ParticipantLeftResult | null> {
  const call = await activeCallById(client, callId);
  if (!call) return null;
  return markParticipantLeftInCall(client, call, userId);
}

async function endCall(client: DbClient, callId: string): Promise<EndCallResult | null> {
  const call = await activeCallById(client, callId);
  if (!call) return null;
  await client.query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [
    call.id,
  ]);
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

async function reconcileLiveKitWebhookEvent(
  client: DbClient,
  event: LiveKitWebhookEvent,
): Promise<LiveKitWebhookResult | null> {
  const callId = callIdFromLiveKitRoom(event.room?.name);
  if (!callId) return null;
  if (event.event === 'room_finished') {
    const result = await endCall(client, callId);
    return result?.ended ? { type: 'room_finished', result } : null;
  }
  if (event.event === 'participant_left') {
    const userId = event.participant?.identity;
    if (!userId || !isUuid(userId)) return null;
    const result = await markParticipantLeft(client, callId, userId);
    return result ? { type: 'participant_left', result } : null;
  }
  return null;
}

export function registerCallRoutes(app: FastifyInstance, deps: CallRouteDeps): void {
  const { pool, hub, calls, voip, requireUser, optionalOpId, runMutation } = deps;
  const livekitWebhookReceiver = createLiveKitWebhookReceiver({
    livekitApiKey: deps.livekitApiKey ?? '',
    livekitApiSecret: deps.livekitApiSecret ?? '',
  });

  if (livekitWebhookReceiver) {
    app.addContentTypeParser(
      'application/webhook+json',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );

    app.post('/api/calls/webhook', async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      let event: LiveKitWebhookEvent;
      try {
        event = await livekitWebhookReceiver.receive(rawBody, req.headers.authorization);
      } catch (err) {
        app.log.warn({ err }, 'livekit webhook verification failed');
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'invalid LiveKit webhook signature' });
      }

      const result = await withTx(pool, (client) => reconcileLiveKitWebhookEvent(client, event));
      if (result?.type === 'participant_left' && result.result.left) {
        hub.publishCallToUsers(result.result.recipients, {
          type: 'call.participant_left',
          callId: result.result.callId,
          userId: event.participant!.identity!,
        });
      }
      if (result?.result.ended) {
        hub.publishCallToUsers(result.result.recipients, {
          type: 'call.ended',
          callId: result.result.callId,
        });
      }
      return { ok: true };
    });
  }

  app.get('/api/calls/active', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { channelId } = decodeRouteQuery(ActiveCallsQuerySchema, req.query);
    if (channelId !== undefined && typeof channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId must be a string' });
    }
    if (channelId && !(await canAccessChannel(pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { calls: await loadActiveCallWiresForUser(pool, user.id, { channelId }) };
  });

  app.post('/api/calls', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(StartCallBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (!calls) return callsUnconfigured(reply);
    if (!(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }

    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'call.start',
      body: { channelId: body.channelId },
      fn: async (client) => {
        let created = false;
        const channel = await client.query<{ id: string; workspace_id: string }>(
          'SELECT id, workspace_id FROM channels WHERE id = $1 FOR UPDATE',
          [body.channelId],
        );
        const channelRow = channel.rows[0];
        if (!channelRow) {
          throw new DomainError(404, 'channel_not_found', 'channel not found');
        }
        const existing = await client.query<CallRow>(
          `SELECT * FROM calls
           WHERE channel_id = $1 AND status <> 'ended'
           ORDER BY started_at DESC
           LIMIT 1
           FOR UPDATE`,
          [body.channelId],
        );
        let call = existing.rows[0];
        if (!call) {
          const id = randomUUID();
          const inserted = await client.query<CallRow>(
            `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status)
             VALUES ($1, $2, $3, $4, $5, 'ringing')
             RETURNING *`,
            [id, channelRow.workspace_id, channelRow.id, user.id, `call:${id}`],
          );
          call = inserted.rows[0]!;
          created = true;
        }
        const existingParticipant = await client.query<{ left_at: Date | null }>(
          'SELECT left_at FROM call_participants WHERE call_id = $1 AND user_id = $2',
          [call.id, user.id],
        );
        const joinedNow =
          existingParticipant.rows.length === 0 || existingParticipant.rows[0]!.left_at != null;
        await client.query(
          `INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
           VALUES ($1, $2, now(), NULL)
           ON CONFLICT (call_id, user_id) DO UPDATE
           SET joined_at = CASE
                 WHEN call_participants.left_at IS NULL THEN call_participants.joined_at
                 ELSE now()
               END,
               left_at = NULL`,
          [call.id, user.id],
        );
        // Promote to 'active' only when joining an EXISTING call; a freshly
        // created call stays 'ringing' so the call.ringing frame's embedded
        // status is honest (it flips to 'active' when a callee accepts).
        if (!created) {
          const updated = await client.query<CallRow>(
            `UPDATE calls SET status = 'active'
             WHERE id = $1 AND status <> 'ended'
             RETURNING *`,
            [call.id],
          );
          call = updated.rows[0]!;
        }
        const wire = await loadCallWire(client, call);
        const token = await calls.mintToken(call.room, user.id, user.displayName);
        return { join: { call: wire, token, url: calls.url }, created, joinedNow };
      },
      onApplied: async (result) => {
        const recipients = await withTx(pool, (client) =>
          channelRecipientIds(client, result.join.call.channelId),
        );
        if (result.created) {
          const ringRecipients = recipients.filter((id) => id !== user.id);
          hub.publishCallToUsers(ringRecipients, { type: 'call.ringing', call: result.join.call });
          void sendIncomingCallVoipPushes(pool, voip, {
            recipientIds: ringRecipients,
            callId: result.join.call.id,
            callerId: user.id,
            callerName: user.displayName,
            channelId: result.join.call.channelId,
          }).catch((err) => {
            app.log.warn({ err }, 'voip push failed');
          });
        } else if (result.joinedNow) {
          hub.publishCallToUsers(recipients, {
            type: 'call.participant_joined',
            callId: result.join.call.id,
            user,
          });
        }
      },
    });
    return response.join;
  });

  app.post('/api/calls/:id/accept', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(CallIdParamsSchema, req.params);
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const response = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      await client.query(
        `INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
         VALUES ($1, $2, now(), NULL)
         ON CONFLICT (call_id, user_id) DO UPDATE
         SET joined_at = CASE
               WHEN call_participants.left_at IS NULL THEN call_participants.joined_at
               ELSE now()
             END,
             left_at = NULL`,
        [call.id, user.id],
      );
      const updated = await client.query<CallRow>(
        `UPDATE calls SET status = 'active'
         WHERE id = $1 AND status <> 'ended'
         RETURNING *`,
        [call.id],
      );
      const current = updated.rows[0]!;
      const wire = await loadCallWire(client, current);
      const token = await calls.mintToken(current.room, user.id, user.displayName);
      return {
        join: { call: wire, token, url: calls.url },
        recipients: await channelRecipientIds(client, current.channel_id),
      };
    });
    hub.publishCallToUsers(response.recipients, {
      type: 'call.accepted',
      callId: response.join.call.id,
      user,
    });
    hub.publishCallToUsers(response.recipients, {
      type: 'call.participant_joined',
      callId: response.join.call.id,
      user,
    });
    return response.join;
  });

  app.post('/api/calls/:id/decline', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(CallIdParamsSchema, req.params);
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const result = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      const recipients = await channelRecipientIds(client, call.channel_id);
      // A DM call has exactly two people: either the callee declining or the
      // caller cancelling ends it (otherwise it would hang in 'ringing' forever
      // with no GC). Group/public declines just dismiss the ring locally.
      const shouldEnd = call.channel_kind === 'dm';
      if (shouldEnd) {
        await client.query(
          "UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1",
          [call.id],
        );
      }
      return { callId: call.id, recipients, ended: shouldEnd };
    });
    hub.publishCallToUsers(result.recipients, {
      type: 'call.declined',
      callId: result.callId,
      userId: user.id,
    });
    if (result.ended) {
      hub.publishCallToUsers(result.recipients, { type: 'call.ended', callId: result.callId });
    }
    return { ok: true };
  });

  app.post('/api/calls/:id/leave', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(CallIdParamsSchema, req.params);
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const result = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      return markParticipantLeftInCall(client, call, user.id);
    });
    if (result.left) {
      hub.publishCallToUsers(result.recipients, {
        type: 'call.participant_left',
        callId: result.callId,
        userId: user.id,
      });
    }
    if (result.ended) {
      hub.publishCallToUsers(result.recipients, { type: 'call.ended', callId: result.callId });
    }
    return { ok: true };
  });
}
