import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import type { AppMutationContext } from '../app-mutations.js';
import type { Db } from '../db.js';
import {
  addChannelMemberTx,
  appendEvent,
  canAccessChannel,
  createChannel,
  getOrCreateDm,
  getOrCreateGdm,
  leaveChannelTx,
  listChannelMembers,
  listChannelsFor,
  listUsers,
  type UserRef,
} from '../events.js';
import type { WsHub } from '../hub.js';
import { workspaceMemberIds } from '../membership.js';
import { decodeRouteBody } from '../route-schema.js';

const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const DmBodySchema = Schema.Struct({
  userId: Schema.optional(Schema.Unknown),
  userIds: Schema.optional(Schema.Unknown),
});

const CreateChannelBodySchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  private: Schema.optional(Schema.Unknown),
});

const ReadChannelBodySchema = Schema.Struct({
  lastReadEventId: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const MuteChannelBodySchema = Schema.Struct({
  muted: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const ArchiveChannelBodySchema = Schema.Struct({
  archived: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const PinChannelBodySchema = Schema.Struct({
  pinned: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const AddChannelMemberBodySchema = Schema.Struct({
  userId: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const ChannelOpBodySchema = Schema.Struct({
  opId: Schema.optional(Schema.Unknown),
});

export interface ChannelRouteDeps extends AppMutationContext {
  pool: Db;
  hub: WsHub;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  activeWorkspaceIdFor(userId: string): Promise<string | null>;
  noWorkspace(reply: FastifyReply): FastifyReply;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { pool, hub, requireUser, optionalOpId, activeWorkspaceIdFor, noWorkspace, runMutation } =
    deps;

  app.get('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { channels: await listChannelsFor(pool, user.id) };
  });

  app.get('/api/users', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { users: await listUsers(pool, user.id) };
  });

  app.post('/api/dms', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(DmBodySchema, req.body);
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter((id): id is string => typeof id === 'string')
      : body.userId && typeof body.userId === 'string'
        ? [body.userId]
        : [];
    const distinctUserIds = [...new Set(userIds)];
    if (distinctUserIds.length < 1 || distinctUserIds.length > 8) {
      return reply.code(400).send({ error: 'bad_request', message: 'userIds must contain 1-8 users' });
    }
    const existingUsers = await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      distinctUserIds,
    ]);
    if (existingUsers.rows.length !== distinctUserIds.length) {
      return reply.code(404).send({ error: 'user_not_found', message: 'user not found' });
    }
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    const isOneToOne = new Set([user.id, ...distinctUserIds]).size <= 2;
    const { channel, created } = isOneToOne
      ? await getOrCreateDm(pool, {
          workspaceId,
          userIdA: user.id,
          userIdB: distinctUserIds[0]!,
        })
      : await getOrCreateGdm(pool, {
          workspaceId,
          creatorId: user.id,
          userIds: distinctUserIds,
        });
    if (created) {
      // Only members learn the DM/GDM exists.
      hub.publishToUsers(
        channel.members?.map((m) => m.id) ?? [user.id, ...distinctUserIds],
        {
          id: 0,
          workspaceId,
          channelId: channel.id,
          threadRootEventId: null,
          type: 'channel.created',
          actorId: user.id,
          payload: { name: channel.name, channel },
          createdAt: new Date().toISOString(),
          author: user,
        },
      );
    }
    return reply.code(created ? 201 : 200).send({ channel });
  });

  app.post('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(CreateChannelBodySchema, req.body);
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(name)) {
      return reply.code(400).send({
        error: 'invalid_channel_name',
        message: 'channel name must be 1-32 chars: lowercase letters, digits, - or _',
      });
    }
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    const { channel, event } = await createChannel(pool, {
      workspaceId,
      name,
      actorId: user.id,
      private: body.private === true,
    });
    const createdEvent = { ...event, payload: { ...event.payload, channel } };
    if (channel.kind === 'public') {
      hub.publishToUsers(await workspaceMemberIds(pool, channel.workspaceId), createdEvent);
    } else {
      hub.publishToUsers([user.id], createdEvent);
    }
    return reply.code(201).send({ channel });
  });

  app.post('/api/channels/:id/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = decodeRouteBody(ReadChannelBodySchema, req.body);
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
    const body = decodeRouteBody(MuteChannelBodySchema, req.body);
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

  app.post('/api/channels/:id/archive', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = decodeRouteBody(ArchiveChannelBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.archived !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'archived must be boolean' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'channel.archive',
      body: { channelId: id, archived: body.archived },
      fn: async (client) => {
        const current = await client.query<{
          workspace_id: string;
          archived_at: Date | null;
        }>('SELECT workspace_id, archived_at FROM channels WHERE id = $1 FOR UPDATE', [id]);
        const row = current.rows[0];
        if (!row) return null;
        const alreadyArchived = row.archived_at !== null;
        if (alreadyArchived === body.archived) {
          return {
            archived: body.archived,
            archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
            event: null,
          };
        }
        const updated = await client.query<{ archived_at: Date | null }>(
          `UPDATE channels
           SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END
           WHERE id = $2
           RETURNING archived_at`,
          [body.archived, id],
        );
        const archivedAt = updated.rows[0]!.archived_at;
        const event = await appendEvent(client, {
          workspaceId: row.workspace_id,
          channelId: id,
          type: body.archived ? 'channel.archived' : 'channel.unarchived',
          actorId: user.id,
          payload: { channelId: id, archivedAt: archivedAt ? archivedAt.toISOString() : null },
        });
        return {
          archived: body.archived,
          archivedAt: archivedAt ? archivedAt.toISOString() : null,
          event,
        };
      },
      onApplied: (result) => {
        if (result?.event) hub.publishEvent(result.event);
      },
    });
    if (!response) return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    return { archived: response.archived, archivedAt: response.archivedAt };
  });

  app.post('/api/channels/:id/pin', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = decodeRouteBody(PinChannelBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.pinned !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'pinned must be boolean' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'channel.pin',
      body: { channelId: id, pinned: body.pinned },
      fn: async (client) => {
        if (body.pinned) {
          await client.query(
            `INSERT INTO channel_pins (user_id, channel_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, channel_id) DO NOTHING`,
            [user.id, id],
          );
        } else {
          await client.query('DELETE FROM channel_pins WHERE user_id = $1 AND channel_id = $2', [user.id, id]);
        }
        return { pinned: body.pinned as boolean };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'channel-pinned', channelId: id, pinned: response.pinned });
      },
    });
  });

  app.get('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const result = await listChannelMembers(pool, { channelId: id, userId: user.id });
    if (!result) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { members: result.members };
  });

  app.post('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = decodeRouteBody(AddChannelMemberBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'channel.member.add',
      body: { channelId: id, userId: body.userId },
      fn: async (client) => {
        const result = await addChannelMemberTx(client, {
          channelId: id,
          actorId: user.id,
          userId: body.userId as string,
        });
        if (!result) return null;
        return { member: result.member, channel: result.channel, event: result.event };
      },
      onApplied: (result) => {
        if (!result) return;
        hub.publishToUsers([body.userId as string], {
          id: 0,
          workspaceId: result.channel.workspaceId,
          channelId: result.channel.id,
          threadRootEventId: null,
          type: 'channel.created',
          actorId: user.id,
          payload: { name: result.channel.name, channel: result.channel },
          createdAt: new Date().toISOString(),
          author: user,
        });
        hub.publishEvent(result.event);
      },
    });
    if (!response) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return reply.code(201).send({ member: response.member });
  });

  app.delete('/api/channels/:id/members/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = decodeRouteBody(ChannelOpBodySchema, req.body);
    const opId = optionalOpId(body);
    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'channel.leave',
      body: { channelId: id },
      fn: async (client) => {
        const result = await leaveChannelTx(client, { channelId: id, userId: user.id });
        if (!result) return null;
        return { ok: true as const, event: result.event };
      },
      onApplied: (result) => {
        if (!result) return;
        hub.publishEvent(result.event);
        hub.sendToUsers([user.id], { type: 'channel-left', channelId: id });
      },
    });
    if (!response) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { ok: true };
  });
}
