import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db, DbClient } from '../db.js';
import { canAccessChannel, listChannelsFor, type UserRef } from '../events.js';
import type { WsHub } from '../hub.js';

export interface ChannelRouteDeps {
  pool: Db;
  hub: WsHub;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  optionalOpId(body: unknown): string | undefined;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { pool, hub, requireUser, optionalOpId, runMutation } = deps;

  app.get('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { channels: await listChannelsFor(pool, user.id) };
  });

  app.post('/api/channels/:id/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { lastReadEventId?: number; opId?: unknown };
    const opId = optionalOpId(body);
    const lastReadEventId = Number(body.lastReadEventId);
    if (!Number.isSafeInteger(lastReadEventId) || lastReadEventId < 0) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'lastReadEventId must be a non-negative integer' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      // 404, not 403 - don't leak the existence of someone else's DM.
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    let advanced = false;
    return runMutation({
      userId: user.id,
      opId,
      opType: 'read.mark',
      body: { channelId: id, lastReadEventId },
      fn: async (client) => {
        const res = await client.query<{ last_read_event_id: string; advanced: boolean }>(
          `WITH previous AS (
             SELECT last_read_event_id
             FROM channel_read_cursors
             WHERE user_id = $1 AND channel_id = $2
           ), upsert AS (
             INSERT INTO channel_read_cursors (user_id, channel_id, last_read_event_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, channel_id) DO UPDATE
             SET last_read_event_id = GREATEST(
                   channel_read_cursors.last_read_event_id,
                   EXCLUDED.last_read_event_id
                 ),
                 updated_at = CASE
                   WHEN EXCLUDED.last_read_event_id > channel_read_cursors.last_read_event_id
                   THEN now()
                   ELSE channel_read_cursors.updated_at
                 END
             RETURNING last_read_event_id
           )
           SELECT upsert.last_read_event_id,
                  COALESCE((SELECT last_read_event_id FROM previous), 0) < upsert.last_read_event_id
                    AS advanced
           FROM upsert`,
          [user.id, id, lastReadEventId],
        );
        const stored = Number(res.rows[0]!.last_read_event_id);
        advanced = res.rows[0]!.advanced;
        return { lastReadEventId: stored };
      },
      onApplied: (response) => {
        if (advanced) {
          hub.sendToUsers([user.id], {
            type: 'read',
            channelId: id,
            lastReadEventId: response.lastReadEventId,
          });
        }
      },
    });
  });

  app.post('/api/channels/:id/mute', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { muted?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.muted !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'muted must be boolean' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'mute.set',
      body: { channelId: id, muted: body.muted },
      fn: async (client) => {
        if (body.muted) {
          await client.query(
            `INSERT INTO channel_mutes (user_id, channel_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, channel_id) DO NOTHING`,
            [user.id, id],
          );
        } else {
          await client.query('DELETE FROM channel_mutes WHERE user_id = $1 AND channel_id = $2', [
            user.id,
            id,
          ]);
        }
        return { muted: body.muted as boolean };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'muted', channelId: id, muted: response.muted });
      },
    });
  });
}
