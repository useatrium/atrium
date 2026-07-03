import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { listChannelMessages, listThreadMessages, type UserRef, type WireEvent } from '../events.js';
import { getObjectBytes } from '../s3.js';
import { ensureSessionCapabilitySnapshots } from '../session-capabilities.js';

type AtriumSessionProjectionModule = typeof import('../atrium-session-projection.js');
type AtriumSessionRecords = Awaited<ReturnType<AtriumSessionProjectionModule['loadSessionRecords']>>;
type AtriumMarkdownRenderer = (
  projection: AtriumSessionProjectionModule,
  records: AtriumSessionRecords,
  sessionId: string,
) => string | Promise<string>;

export interface AtriumRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
  canViewFull(userId: string): Promise<boolean>;
  fullViewForbidden(reply: FastifyReply): FastifyReply;
}

export function registerAtriumRoutes(app: FastifyInstance, deps: AtriumRouteDeps): void {
  const { pool, requireUser, requireSessionAccess, canViewFull, fullViewForbidden } = deps;

  app.get('/api/sessions/:id/atrium/chat', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { channel?: unknown; thread?: unknown };
    const channelId = typeof q.channel === 'string' ? q.channel.trim() : '';
    if (channelId.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'channel is required' });
    }
    const session = await pool.query<{ channel_id: string }>('SELECT channel_id FROM sessions WHERE id = $1', [id]);
    if (session.rows[0]?.channel_id !== channelId) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }

    const rawThread = q.thread;
    let events: WireEvent[] = [];
    let title = channelId;
    if (rawThread == null || rawThread === '') {
      let beforeId: number | undefined;
      for (let pageCount = 0; pageCount < 5; pageCount++) {
        const page = await listChannelMessages(pool, {
          channelId,
          limit: 200,
          ...(beforeId === undefined ? {} : { beforeId }),
        });
        events = [...page.events, ...events];
        if (!page.hasMore || page.events.length === 0) break;
        beforeId = page.events[0]!.id;
      }
    } else if (typeof rawThread === 'string') {
      const threadRootEventId = Number(rawThread.trim());
      if (!Number.isSafeInteger(threadRootEventId) || threadRootEventId <= 0) {
        return reply.code(400).send({ error: 'bad_query', message: 'thread must be a positive event id' });
      }
      const root = await pool.query<{ channel_id: string | null }>(
        `SELECT channel_id
         FROM events
         WHERE id = $1 AND type IN ('message.posted', 'session.spawned')`,
        [threadRootEventId],
      );
      if (root.rows[0]?.channel_id !== channelId) {
        return reply.code(404).send({ error: 'thread_not_found', message: 'thread not found' });
      }
      events = (await listThreadMessages(pool, { rootEventId: threadRootEventId })).events;
      title = `${channelId}/${threadRootEventId}`;
    } else {
      return reply.code(400).send({ error: 'bad_query', message: 'thread must be a positive event id' });
    }

    const messages = events.filter(
      (event) => event.type === 'message.posted' && event.channelId === channelId && event.payload.deleted !== true,
    );
    const lines = [`# ${title}`, ''];
    for (const event of messages) {
      const author = event.author?.displayName ?? event.author?.handle ?? event.actorId ?? 'unknown';
      const tag = event.payload.edited === true ? ' (edited)' : '';
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      lines.push(`**${author}**${tag}: ${text}`);
    }
    return reply.send({ markdown: `${lines.join('\n')}\n`, messageCount: messages.length });
  });

  async function sendAtriumMarkdown(
    req: FastifyRequest,
    reply: FastifyReply,
    tier: 'lean' | 'full',
    render: AtriumMarkdownRenderer,
    requireFullView = false,
  ) {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    if (requireFullView && !(await canViewFull(user.id))) return fullViewForbidden(reply);
    const { id } = req.params as { id: string };
    const projection = await import('../atrium-session-projection.js');
    const records = await projection.loadSessionRecords(pool, id, tier);
    const markdown = await render(projection, records, id);
    return reply.type('text/markdown; charset=utf-8').send(markdown);
  }

  app.get('/api/sessions/:id/atrium/transcript', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'lean', (projection, records) => projection.renderTranscriptMarkdown(records)),
  );

  app.get('/api/sessions/:id/atrium/full', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', (projection, records) => projection.renderFullMarkdown(records), true),
  );

  app.get('/api/sessions/:id/atrium/summary', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', async (projection, records, sessionId) =>
      projection.renderSummaryMarkdown(records, await projection.buildSessionMeta(pool, sessionId)),
    ),
  );

  app.get('/api/sessions/:id/atrium/meta', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { buildSessionMeta } = await import('../atrium-session-projection.js');
    return reply.type('application/json').send(await buildSessionMeta(pool, id));
  });

  app.get('/api/sessions/:id/atrium/capabilities', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const snapshots = await ensureSessionCapabilitySnapshots(pool, { getObjectBytes }, id);
    return reply.type('application/json').send({ sessionId: id, snapshots });
  });

  app.get('/api/sessions/:id/atrium/changes-doc', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', (projection, records) => projection.renderChangesMarkdown(records)),
  );

  app.get('/api/sessions/:id/atrium/tools', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', (projection, records) => projection.renderToolsMarkdown(records)),
  );

  app.get('/api/sessions/:id/atrium/artifacts', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'lean', (projection, records) => projection.renderArtifactsMarkdown(records)),
  );

  app.get('/api/sessions/:id/atrium/events', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    if (!(await canViewFull(user.id))) return fullViewForbidden(reply);
    const { id } = req.params as { id: string };
    const { loadSessionRecords, renderEventsJsonl } = await import('../atrium-session-projection.js');
    const records = await loadSessionRecords(pool, id, 'full');
    return reply.type('application/jsonl; charset=utf-8').send(renderEventsJsonl(records));
  });

  app.post('/api/sessions/:id/atrium/reproject', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { projectAndEmitChange } = await import('../session-record-changefeed.js');
    const projected = await projectAndEmitChange(pool, id);
    return reply.send({ projected });
  });

  app.get('/api/atrium/changes', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { since?: string; limit?: string };
    const changefeed = await import('../session-record-changefeed.js');

    let cursor = changefeed.SESSION_RECORD_CHANGE_CURSOR_ZERO;
    if (typeof q.since === 'string' && q.since.length > 0) {
      const m = /^(\d+)\.(\d+)$/.exec(q.since);
      if (!m) {
        return reply.code(400).send({ error: 'bad_query', message: 'since must be "<xid>.<id>"' });
      }
      cursor = { xid: m[1]!, id: m[2]! };
    }

    let limit = 500;
    if (typeof q.limit === 'string') {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        return reply.code(400).send({ error: 'bad_query', message: 'limit must be 1..5000' });
      }
      limit = n;
    }

    const page = await changefeed.sessionRecordChangesSince(pool, {
      userId: user.id,
      cursor,
      limit,
    });
    return reply.send({
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });
}
