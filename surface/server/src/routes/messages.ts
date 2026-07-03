import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db, DbClient } from '../db.js';
import { withTx } from '../db.js';
import {
  appendVoiceTranscribedEventTx,
  canAccessChannel,
  deleteMessageTx,
  DomainError,
  editMessageTx,
  listChannelMessages,
  listThreadMessages,
  postMessage,
  setReactionTx,
  type AttachmentMeta,
  type ReactionAction,
  type UserRef,
} from '../events.js';
import type { WsHub } from '../hub.js';
import { sendMessagePush } from '../push.js';
import { landUploadAttachmentAsArtifact, type UploadAttachmentFileRow } from '../upload-artifacts.js';

type MessageAttachmentFileRow = UploadAttachmentFileRow;

export interface MessageRouteDeps {
  pool: Db;
  hub: WsHub;
  stt?: { enqueue(): void };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalUuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function parseVoicePost(
  input: unknown,
  attachments: AttachmentMeta[] | undefined,
): { durationMs: number; waveform?: number[] } | undefined {
  if (input == null) return undefined;
  if (!isPlainObject(input)) {
    throw new DomainError(400, 'bad_voice', 'voice must be an object');
  }
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new DomainError(400, 'bad_voice', 'voice.durationMs must be a positive number');
  }
  const ct = attachments?.[0]?.contentType.toLowerCase() ?? '';
  if (attachments?.length !== 1 || !(ct.startsWith('audio/') || ct === 'application/octet-stream')) {
    throw new DomainError(400, 'bad_voice', 'voice messages require exactly one audio attachment');
  }
  const waveform = Array.isArray(input.waveform)
    ? input.waveform.slice(0, 256).map((value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.min(1, Math.max(0, n));
      })
    : undefined;
  return { durationMs, ...(waveform && waveform.length > 0 ? { waveform } : {}) };
}

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { pool, hub, requireUser, optionalOpId, runMutation } = deps;

  app.get('/api/channels/:id/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const q = req.query as { before_id?: string; after_id?: string; limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const beforeId = q.before_id ? Number(q.before_id) : undefined;
    const afterId = q.after_id ? Number(q.after_id) : undefined;
    if ([limit, beforeId, afterId].some((v) => v !== undefined && !Number.isFinite(v))) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric query params expected' });
    }
    if (beforeId !== undefined && afterId !== undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'use before_id or after_id, not both' });
    }
    return listChannelMessages(pool, { channelId: id, beforeId, afterId, limit });
  });

  app.get('/api/threads/:rootEventId/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const rootEventId = Number((req.params as { rootEventId: string }).rootEventId);
    if (!Number.isFinite(rootEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric root event id expected' });
    }
    const root = await pool.query<{ channel_id: string | null }>('SELECT channel_id FROM events WHERE id = $1', [
      rootEventId,
    ]);
    const channelId = root.rows[0]?.channel_id;
    if (!channelId || !(await canAccessChannel(pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'thread_not_found', message: 'thread not found' });
    }
    return listThreadMessages(pool, { rootEventId });
  });

  app.post('/api/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      text?: string;
      clientMsgId?: string;
      threadRootEventId?: number;
      attachments?: unknown;
      voice?: unknown;
    };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    const attachmentIds = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is string => typeof a === 'string').slice(0, 10)
      : [];
    if (text.trim().length === 0 && attachmentIds.length === 0 && body.voice == null) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    let attachments: AttachmentMeta[] | undefined;
    let uploadAttachmentFiles: MessageAttachmentFileRow[] = [];
    if (attachmentIds.length > 0) {
      const rows = await pool.query<MessageAttachmentFileRow>(
        `SELECT id, filename, content_type, size_bytes, width, height, s3_key, content_hash
         FROM files WHERE id = ANY($1::uuid[]) AND uploader_id = $2`,
        [attachmentIds, user.id],
      );
      if (rows.rows.length !== attachmentIds.length) {
        return reply.code(400).send({ error: 'bad_attachment', message: 'unknown or foreign attachment id' });
      }
      const fileById = new Map(rows.rows.map((row) => [row.id, row]));
      uploadAttachmentFiles = attachmentIds.map((id) => fileById.get(id)!);
      attachments = uploadAttachmentFiles.map((f) => {
        return {
          id: f.id,
          filename: f.filename,
          contentType: f.content_type,
          size: Number(f.size_bytes),
          ...(f.width != null ? { width: f.width } : {}),
          ...(f.height != null ? { height: f.height } : {}),
        };
      });
    }
    const rawClientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.length <= 64 ? body.clientMsgId : null;
    const clientMsgId =
      uploadAttachmentFiles.length > 0 ? (optionalUuid(rawClientMsgId) ?? randomUUID()) : rawClientMsgId;
    const threadRootEventId = body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    const voice = parseVoicePost(body.voice, attachments);
    const channel = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      body.channelId,
    ]);
    if (!channel.rows[0] || !(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const event = await postMessage(pool, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: body.channelId,
      actorId: user.id,
      text,
      clientMsgId,
      threadRootEventId,
      attachments,
      voice,
    });
    hub.publishEvent(event);
    for (const file of uploadAttachmentFiles) {
      if (file.content_hash == null) {
        app.log.warn(
          { fileId: file.id, filename: file.filename },
          'upload attachment artifact landing skipped: missing content_hash',
        );
        continue;
      }
      try {
        await landUploadAttachmentAsArtifact(pool, {
          channelId: body.channelId,
          userId: user.id,
          file,
          sourceMessageId: optionalUuid(event.payload.client_msg_id),
          logger: app.log,
        });
      } catch (err) {
        app.log.warn({ err, fileId: file.id, filename: file.filename }, 'upload attachment artifact landing failed');
      }
    }
    if (voice) deps.stt?.enqueue();
    void sendMessagePush(pool, hub, event).catch((err) => app.log.warn({ err }, 'push fanout failed'));
    return reply.code(201).send({ event });
  });

  app.post('/api/voice/:fileId/retranscribe', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { fileId } = req.params as { fileId: string };
    const tr = await pool.query<{ channel_id: string | null; event_id: number; status: string }>(
      'SELECT channel_id, event_id, status FROM transcripts WHERE file_id = $1',
      [fileId],
    );
    const row = tr.rows[0];
    if (!row || !row.channel_id || !(await canAccessChannel(pool, user.id, row.channel_id))) {
      return reply.code(404).send({ error: 'not_found', message: 'transcript not found' });
    }
    if (row.status !== 'failed') {
      return reply.code(409).send({ error: 'not_retryable', message: 'transcript is not in a failed state' });
    }
    const event = await withTx(pool, async (client) => {
      await client.query(
        `UPDATE transcripts
         SET status = 'pending', attempts = 0, error = NULL, updated_at = now()
         WHERE file_id = $1`,
        [fileId],
      );
      return appendVoiceTranscribedEventTx(client, {
        targetEventId: row.event_id,
        transcript: { status: 'pending' },
      });
    });
    hub.publishEvent(event);
    deps.stt?.enqueue();
    return reply.code(202).send({ event });
  });

  app.patch('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { text?: string; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'message.edit',
      body: { targetEventId, text },
      fn: async (client) => {
        const event = await editMessageTx(client, { targetEventId, actorId: user.id, text });
        return { event };
      },
      onApplied: (response) => {
        hub.publishEvent(response.event);
      },
    });
  });

  app.delete('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    return runMutation({
      userId: user.id,
      opId,
      opType: 'message.delete',
      body: { targetEventId },
      fn: async (client) => {
        const event = await deleteMessageTx(client, { targetEventId, actorId: user.id });
        return { event };
      },
      onApplied: (response) => {
        hub.publishEvent(response.event);
      },
    });
  });

  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { emoji?: string; action?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.emoji !== 'string' || !body.emoji) {
      return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
    }
    if (body.action !== 'add' && body.action !== 'remove') {
      return reply.code(400).send({ error: 'bad_request', message: "action must be 'add' or 'remove'" });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'reaction.set',
      body: { targetEventId, emoji: body.emoji, action: body.action },
      fn: async (client) => {
        const result = await setReactionTx(client, {
          targetEventId,
          actorId: user.id,
          emoji: body.emoji as string,
          action: body.action as ReactionAction,
        });
        return result.applied ? { event: result.event } : { event: null, applied: false as const };
      },
      onApplied: (response) => {
        if (response.event) hub.publishEvent(response.event);
      },
    });
  });
}
