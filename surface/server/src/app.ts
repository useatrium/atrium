import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import type { Db } from './db.js';
import { signSession, verifySession } from './cookie.js';
import {
  DomainError,
  createChannel,
  deleteMessage,
  editMessage,
  listChannelMessages,
  listChannels,
  listThreadMessages,
  listWorkspaces,
  postMessage,
  searchMessages,
  toggleReaction,
  type UserRef,
} from './events.js';
import { WsHub } from './hub.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRef | null;
  }
}

export interface AppDeps {
  pool: Db;
  hub?: WsHub;
  sessionSecret?: string;
  sessionRuns?: SessionRunsOptions;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const hub = deps.hub ?? new WsHub();
  const secret = deps.sessionSecret ?? config.sessionSecret;
  const sessionRuns = new SessionRuns(pool, hub, deps.sessionRuns);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: 'internal', message: 'internal error' });
  });

  async function userFromRequest(req: FastifyRequest): Promise<UserRef | null> {
    const sessionId = verifySession(req.cookies[config.sessionCookie], secret);
    if (!sessionId) return null;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    const res = await pool.query<{ id: string; handle: string; display_name: string }>(
      `SELECT u.id, u.handle, u.display_name
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [sessionId],
    );
    const row = res.rows[0];
    return row ? { id: row.id, handle: row.handle, displayName: row.display_name } : null;
  }

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    req.user = await userFromRequest(req);
  });

  function requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null {
    if (!req.user) {
      reply.code(401).send({ error: 'unauthorized', message: 'login required' });
      return null;
    }
    return req.user;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { handle?: string; displayName?: string };
    const handle = String(body.handle ?? '').trim().toLowerCase();
    const displayName = String(body.displayName ?? '').trim();
    if (!HANDLE_RE.test(handle)) {
      return reply.code(400).send({
        error: 'invalid_handle',
        message: 'handle must be 2-32 chars: letters, digits, - or _',
      });
    }
    if (displayName.length > 64) {
      return reply.code(400).send({ error: 'invalid_display_name', message: 'display name too long' });
    }
    // A blank display name means "keep what I had" for returning users —
    // re-logins must not silently rewrite attribution across history.
    const user = await pool.query<{ id: string; handle: string; display_name: string }>(
      `INSERT INTO users (handle, display_name) VALUES ($1, COALESCE(NULLIF($2, ''), $1))
       ON CONFLICT (handle) DO UPDATE SET display_name = COALESCE(NULLIF($2, ''), users.display_name)
       RETURNING id, handle, display_name`,
      [handle, displayName],
    );
    const u = user.rows[0]!;
    const session = await pool.query<{ id: string }>(
      'INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id',
      [u.id],
    );
    reply.setCookie(config.sessionCookie, signSession(session.rows[0]!.id, secret), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return { user: { id: u.id, handle: u.handle, displayName: u.display_name } };
  });

  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { user };
  });

  app.post('/auth/logout', async (req, reply) => {
    const sessionId = verifySession(req.cookies[config.sessionCookie], secret);
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
      await pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
    }
    reply.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Workspaces & channels
  // -------------------------------------------------------------------------

  app.get('/api/workspaces', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { workspaces: await listWorkspaces(pool) };
  });

  app.get('/api/channels', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { channels: await listChannels(pool) };
  });

  app.post('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: string };
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(name)) {
      return reply.code(400).send({
        error: 'invalid_channel_name',
        message: 'channel name must be 1-32 chars: lowercase letters, digits, - or _',
      });
    }
    const workspaces = await listWorkspaces(pool);
    const ws = workspaces[0];
    if (!ws) return reply.code(500).send({ error: 'no_workspace', message: 'no workspace bootstrapped' });
    const { channel, event } = await createChannel(pool, {
      workspaceId: ws.id,
      name,
      actorId: user.id,
    });
    // channel.created is broadcast to everyone so sidebars stay live.
    hub.publishGlobal({ ...event, payload: { ...event.payload, channel } });
    return reply.code(201).send({ channel });
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  app.get('/api/channels/:id/messages', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const { id } = req.params as { id: string };
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

  app.get('/api/search', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const q = (req.query as { q?: string; limit?: string });
    const query = String(q.q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'bad_query', message: 'query must be at least 2 chars' });
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric limit expected' });
    }
    return { results: await searchMessages(pool, { query, limit }) };
  });

  app.get('/api/threads/:rootEventId/messages', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const rootEventId = Number((req.params as { rootEventId: string }).rootEventId);
    if (!Number.isFinite(rootEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric root event id expected' });
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
    };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    const clientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.length <= 64
        ? body.clientMsgId
        : null;
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    const channel = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [body.channelId],
    );
    if (!channel.rows[0]) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const event = await postMessage(pool, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: body.channelId,
      actorId: user.id,
      text,
      clientMsgId,
      threadRootEventId,
    });
    hub.publishEvent(event);
    return reply.code(201).send({ event });
  });

  app.patch('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    const event = await editMessage(pool, { targetEventId, actorId: user.id, text });
    hub.publishEvent(event);
    return { event };
  });

  app.delete('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const event = await deleteMessage(pool, { targetEventId, actorId: user.id });
    hub.publishEvent(event);
    return { event };
  });

  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { emoji?: string };
    if (typeof body.emoji !== 'string' || !body.emoji) {
      return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
    }
    const event = await toggleReaction(pool, {
      targetEventId,
      actorId: user.id,
      emoji: body.emoji,
    });
    hub.publishEvent(event);
    return { event };
  });

  // -------------------------------------------------------------------------
  // Agent sessions
  // -------------------------------------------------------------------------

  app.post('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      threadRootEventId?: number;
      task?: string;
      harness?: string;
    };
    const task = typeof body.task === 'string' ? body.task : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (task.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_task', message: 'task is empty' });
    }
    if (Buffer.byteLength(task, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'task_too_large', message: 'task exceeds 8KB' });
    }
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    const session = await sessionRuns.createSession({
      channelId: body.channelId,
      threadRootEventId,
      task,
      harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
      user,
    });
    return reply.code(201).send({ session });
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { session: await sessionRuns.getSessionForUser(id, user.id) };
  });

  app.get('/api/sessions/:id/stream', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { after_event_id?: string };
    const afterEventId = q.after_event_id ? Number(q.after_event_id) : 0;
    if (!Number.isFinite(afterEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'after_event_id must be numeric' });
    }
    const session = await sessionRuns.getSessionForUser(id, user.id);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    await sessionRuns.streamCentaurEvents(session, user.id, afterEventId, reply.raw, abort.signal);
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    await sessionRuns.postUserMessage(id, user.id, text);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/request', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.requestSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/grant', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userId?: string };
    if (!body.userId || typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    await sessionRuns.grantSeat(id, user.id, body.userId);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/take', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.takeSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.cancelSession(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, async (socket, req) => {
      const user = await userFromRequest(req as FastifyRequest);
      if (!user) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const client = hub.addClient(socket, user);
      socket.on('pong', () => {
        client.isAlive = true;
      });
      socket.on('message', (raw: Buffer) => {
        let msg: { type?: string; channelIds?: unknown; channelId?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'subscribe' && Array.isArray(msg.channelIds)) {
          const ids = msg.channelIds
            .filter((c): c is string => typeof c === 'string')
            .slice(0, 500);
          hub.subscribe(client, ids);
        } else if (msg.type === 'focus') {
          hub.setFocus(client, typeof msg.channelId === 'string' ? msg.channelId : null);
        } else if (msg.type === 'typing') {
          if (typeof msg.channelId === 'string') hub.relayTyping(client, msg.channelId);
        } else if (msg.type === 'ping') {
          hub.sendTo(client, { type: 'pong', t: Date.now() });
        }
      });
      const cleanup = () => hub.removeClient(client);
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });
  });

  app.addHook('onReady', async () => {
    await sessionRuns.resumeActiveSessions();
  });
  app.addHook('onClose', async () => {
    await sessionRuns.close();
  });

  return app;
}
