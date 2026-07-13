import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { parseChangePage } from '../change-page.js';
import type { UserRef } from '../events.js';
import type { SessionRuns } from '../session-runs.js';

interface InternalViewer extends UserRef {
  sessionId: string;
  activeChannelId: string;
  driver: UserRef | null;
}

type DeltaMode = 'full' | 'append';

export interface InternalAtriumRouteDeps {
  pool: Db;
  sessionRuns: SessionRuns;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  canViewFull(userId: string): Promise<boolean>;
  fullViewForbidden(reply: FastifyReply): FastifyReply;
}

export function registerInternalAtriumRoutes(app: FastifyInstance, deps: InternalAtriumRouteDeps): void {
  const { pool, sessionRuns, requireCaptureKey, canViewFull, fullViewForbidden } = deps;

  async function resolveViewer(viewerId: string, reply: FastifyReply): Promise<InternalViewer | null> {
    const res = await pool.query<{
      session_id: string;
      channel_id: string;
      id: string;
      handle: string;
      display_name: string;
      driver_id: string | null;
      driver_handle: string | null;
      driver_display_name: string | null;
    }>(
      `SELECT s.id::text AS session_id,
              s.channel_id::text AS channel_id,
              u.id,
              u.handle,
              u.display_name,
              driver.id AS driver_id,
              driver.handle AS driver_handle,
              driver.display_name AS driver_display_name
       FROM sessions s
       JOIN users u ON u.id = s.spawned_by
       LEFT JOIN users driver ON driver.id = s.driver_id
       WHERE s.id::text = $1 OR s.centaur_thread_key = $1
       LIMIT 1`,
      [viewerId],
    );
    const user = res.rows[0];
    if (!user) {
      reply.code(404).send({ error: 'viewer_not_found', message: 'viewer session not found' });
      return null;
    }
    return {
      sessionId: user.session_id,
      activeChannelId: user.channel_id,
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      driver: user.driver_id
        ? {
            id: user.driver_id,
            handle: user.driver_handle ?? user.driver_id,
            displayName: user.driver_display_name ?? user.driver_handle ?? user.driver_id,
          }
        : null,
    };
  }

  function setSessionDeltaHeaders(reply: FastifyReply, epoch: string, mode: DeltaMode, nextSeq: number): void {
    reply.header('x-atrium-epoch', epoch);
    reply.header('x-atrium-delta', mode);
    reply.header('x-atrium-next-seq', String(nextSeq));
  }

  function setChannelDeltaHeaders(reply: FastifyReply, epoch: string, mode: DeltaMode, nextEventId: number): void {
    reply.header('x-atrium-epoch', epoch);
    reply.header('x-atrium-delta', mode);
    reply.header('x-atrium-next-event-id', String(nextEventId));
  }

  app.get('/api/internal/sessions/:viewerId/atrium/changes', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId } = req.params as { viewerId: string };
    const q = req.query as { since?: string; limit?: string };
    const changefeed = await import('../session-record-changefeed.js');

    const pageRequest = parseChangePage(reply, q, changefeed.SESSION_RECORD_CHANGE_CURSOR_ZERO);
    if (!pageRequest) return;

    const viewerUser = await resolveViewer(viewerId, reply);
    if (!viewerUser) return;

    const page = await changefeed.sessionRecordChangesSince(pool, {
      userId: viewerUser.id,
      cursor: pageRequest.cursor,
      limit: pageRequest.limit,
    });
    return reply.send({
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });

  app.get('/api/internal/sessions/:viewerId/atrium/channels', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId } = req.params as { viewerId: string };
    const viewer = await resolveViewer(viewerId, reply);
    if (!viewer) return;
    const projection = await import('../atrium-channel-projection.js');
    const channels = await projection.loadReadableChannels(pool, {
      userId: viewer.id,
      activeChannelId: viewer.activeChannelId,
    });
    return reply.send(channels.map((channel) => ({ ...channel, last_event_id: channel.lastEventId })));
  });

  app.get('/api/internal/sessions/:viewerId/atrium/channels/:channelId/:doc', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId, channelId, doc } = req.params as {
      viewerId: string;
      channelId: string;
      doc: string;
    };
    const viewer = await resolveViewer(viewerId, reply);
    if (!viewer) return;
    if (doc !== 'channel' && doc !== 'chat') {
      return reply.code(404).send({ error: 'doc_not_found', message: 'atrium channel doc not found' });
    }

    const projection = await import('../atrium-channel-projection.js');
    const info = await projection.loadChannelDocInfo(
      pool,
      { userId: viewer.id, activeChannelId: viewer.activeChannelId, driver: viewer.driver },
      channelId,
    );
    if (!info) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    if (doc === 'channel') {
      setChannelDeltaHeaders(reply, projection.CHANNEL_EPOCH, 'full', info.lastEventId);
      return reply.type('text/markdown; charset=utf-8').send(projection.renderChannelMarkdown(info));
    }
    const query = req.query as { since_event_id?: string; epoch?: string };
    const sinceEventId = parseWatermark(query.since_event_id);
    const requestedAppend =
      sinceEventId != null && query.epoch === projection.CHANNEL_EPOCH && sinceEventId <= info.lastEventId;
    const chat = await projection.loadChannelChatProjection(pool, channelId, sinceEventId);
    if (requestedAppend && !chat.historyMutated) {
      const delta = projection.renderChannelChatDelta(chat.messages, sinceEventId);
      if (delta.preservesHistory) {
        setChannelDeltaHeaders(reply, projection.CHANNEL_EPOCH, 'append', info.lastEventId);
        return reply.type('text/markdown; charset=utf-8').send(delta.body);
      }
    }
    setChannelDeltaHeaders(reply, projection.CHANNEL_EPOCH, 'full', info.lastEventId);
    return reply.type('text/markdown; charset=utf-8').send(projection.renderChannelChatMarkdown(chat.messages));
  });

  app.get('/api/internal/sessions/:viewerId/atrium/sessions/:targetId/:doc', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId, targetId, doc } = req.params as {
      viewerId: string;
      targetId: string;
      doc: string;
    };
    const viewerUser = await resolveViewer(viewerId, reply);
    if (!viewerUser) return;

    if (!(await sessionRuns.userCanAccessSession(targetId, viewerUser.id))) {
      return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    }

    const projection = await import('../atrium-session-projection.js');
    const query = req.query as { since_seq?: string; epoch?: string };
    const sinceSeq = parseWatermark(query.since_seq);
    const state = await projection.loadSessionDeltaState(pool, targetId);
    const afterSeq = sinceSeq ?? 0;
    const appendRequested =
      doc !== 'summary' &&
      doc !== 'meta' &&
      sinceSeq != null &&
      query.epoch === state.epoch &&
      sinceSeq <= state.nextSeq;
    const appendable = appendRequested && (await projection.sessionDocHadContent(pool, targetId, doc, afterSeq));
    const mode: DeltaMode = appendable ? 'append' : 'full';
    setSessionDeltaHeaders(reply, state.epoch, mode, state.nextSeq);
    switch (doc) {
      case 'transcript': {
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'lean', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'lean');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(
            appendable
              ? projection.renderTranscriptMarkdownAppend(records)
              : projection.renderTranscriptMarkdown(records),
          );
      }
      case 'full': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'full', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(appendable ? projection.renderFullMarkdownAppend(records) : projection.renderFullMarkdown(records));
      }
      case 'summary': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        const meta = await projection.buildSessionMeta(pool, targetId);
        return reply.type('text/markdown; charset=utf-8').send(projection.renderSummaryMarkdown(records, meta));
      }
      case 'meta':
        return reply.type('application/json').send(await projection.buildSessionMeta(pool, targetId));
      case 'tools': {
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'full', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(appendable ? projection.renderToolsMarkdownAppend(records) : projection.renderToolsMarkdown(records));
      }
      case 'artifacts': {
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'lean', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'lean');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(
            appendable
              ? projection.renderArtifactsMarkdownAppend(records)
              : projection.renderArtifactsMarkdown(records),
          );
      }
      case 'changes-doc': {
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'full', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(
            appendable ? projection.renderChangesMarkdownAppend(records) : projection.renderChangesMarkdown(records),
          );
      }
      case 'events': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = appendable
          ? await projection.loadSessionRecordsAfter(pool, targetId, 'full', afterSeq)
          : await projection.loadSessionRecords(pool, targetId, 'full');
        return reply.type('application/jsonl; charset=utf-8').send(projection.renderEventsJsonl(records));
      }
      default:
        return reply.code(404).send({ error: 'doc_not_found', message: 'atrium doc not found' });
    }
  });
}

function parseWatermark(value: string | undefined): number | undefined {
  if (value == null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
