import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import { canonicalizeRouteArtifactPath, firstHeader, normalizeMime, parseBaseSeq } from '../artifact-route-utils.js';
import { writeBackArtifact } from '../artifact-writeback.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';

export interface ChannelArtifactWritebackRouteDeps {
  pool: Db;
  maxUploadBytes: number;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

export async function registerChannelArtifactWritebackRoutes(
  app: FastifyInstance,
  deps: ChannelArtifactWritebackRouteDeps,
): Promise<void> {
  const { pool, maxUploadBytes, requireUser } = deps;

  await app.register(async (writeback) => {
    writeback.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );

    writeback.put('/api/channels/:channelId/artifacts', async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const { channelId } = req.params as { channelId: string };
      if (!(await canAccessChannel(pool, user.id, channelId))) {
        return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
      }

      const query = req.query as { path?: unknown; session?: unknown };
      const headerPath = firstHeader(req.headers['x-artifact-path']);
      const queryPath = typeof query.path === 'string' ? query.path.trim() : '';
      const path = (queryPath || headerPath?.trim() || '').trim();
      if (!path) {
        return reply.code(400).send({ error: 'bad_request', message: 'valid artifact path required' });
      }

      const sessionId = typeof query.session === 'string' ? query.session.trim() : '';
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
      }
      const session = await pool.query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1 AND channel_id = $2`, [
        sessionId,
        channelId,
      ]);
      if (!session.rows[0]) {
        return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
      }
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, { sessionId, channelId });
      if (!canonicalPath) return;

      const body = Buffer.isBuffer(req.body)
        ? req.body
        : req.body instanceof Uint8Array
          ? Buffer.from(req.body)
          : Buffer.alloc(0);
      const mime = normalizeMime(firstHeader(req.headers['content-type']));
      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }

      const result = await writeBackArtifact({
        pool,
        storage: { uploadObject, getObjectBytes, headObject },
        channelId,
        sessionId,
        path: canonicalPath,
        bytes: body,
        mime,
        author: `human:${user.id}`,
        ...(baseSeq == null ? {} : { baseSeq }),
      });
      if (!result.ok) {
        return reply.code(409).send({
          error: result.reason === 'stale_base' ? 'stale_base' : result.reason,
          ...(result.baseSeq != null ? { baseSeq: result.baseSeq } : {}),
          ...(result.latestSeq != null ? { latestSeq: result.latestSeq } : {}),
        });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });
}
