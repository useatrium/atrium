import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { withTx } from '../db.js';
import {
  ArtifactLedger,
  casBlobKey,
  CHANGE_CURSOR_ZERO,
  type ChangeCursor,
  type CommitVersionGroupFile,
} from '../artifact-ledger.js';
import { artifactPathInRoots, type ArtifactScopeRoot } from '../artifact-scope.js';
import { canonicalizeSessionArtifactPath, InvalidArtifactPathError } from '../artifact-path.js';
import { canonicalizeRouteArtifactPath, firstHeader, normalizeMime, parseBaseSeq } from '../artifact-route-utils.js';
import { writeBackArtifact, writeBackDelete } from '../artifact-writeback.js';
import { classifyMedia } from '../media-classifier.js';
import { copyObject, deleteObject, getObjectBytes, headObject, uploadObject, uploadObjectStream } from '../s3.js';
import { enqueueThumbnailGeneration } from '../thumbnails.js';

type InternalSessionRef = {
  id: string;
  channelId: string;
  workspaceId: string;
};

type SessionArtifactAccess = {
  workspaceId: string;
  channelId: string;
  readableChannelIds: readonly string[];
  activePrefix: string;
  readableRoots: readonly ArtifactScopeRoot[];
  writableRoots: readonly ArtifactScopeRoot[];
};

export interface InternalArtifactRouteDeps {
  pool: Db;
  maxUploadBytes: number;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null>;
  sessionArtifactAccess(sessionId: string, userId?: string | null): Promise<SessionArtifactAccess>;
  serializeArtifactRoots(
    roots: readonly ArtifactScopeRoot[],
  ): Array<{ prefix: string; scope: string; writable: boolean }>;
}

function isReadableStream(value: unknown): value is Readable {
  const candidate = value as { pipe?: unknown } | null;
  return candidate != null && typeof candidate.pipe === 'function';
}

export async function registerInternalArtifactRoutes(
  app: FastifyInstance,
  deps: InternalArtifactRouteDeps,
): Promise<void> {
  const {
    pool,
    maxUploadBytes,
    requireCaptureKey,
    resolveInternalSessionRef,
    sessionArtifactAccess,
    serializeArtifactRoots,
  } = deps;

  app.get('/api/internal/sessions/:id/artifacts/changes', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    let cursor: ChangeCursor = CHANGE_CURSOR_ZERO;
    if (typeof q.since === 'string' && q.since.length > 0) {
      const m = /^(\d+)\.(\d+)$/.exec(q.since);
      if (!m) return reply.code(400).send({ error: 'bad_query', message: 'since must be "<xid>.<id>"' });
      cursor = { xid: m[1]!, id: m[2]! };
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const page = await new ArtifactLedger(pool).changesSince(session.id, cursor, 500);
    return reply.send({
      activePrefix: `shared/channels/${session.channelId}`,
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });

  app.get('/api/internal/sessions/:id/artifacts/raw', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; seq?: string };
    if (typeof q.path !== 'string' || q.path.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);
    const path = canonicalizeRouteArtifactPath(reply, q.path, {
      sessionId: session.id,
      channelId: session.channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'not_found', message: 'no servable version' });
    }
    const ref = typeof q.seq === 'string' && /^\d+$/.test(q.seq) ? { seq: Number(q.seq) } : { pointer: 'latest' };
    const v = await new ArtifactLedger(pool).resolveVersion(session.id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    if (!v || v.kind === 'deleted' || v.tombstoned) {
      return reply.code(404).send({ error: 'not_found', message: 'no servable version' });
    }
    if (!v.blobSha || !v.s3Key) {
      return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
    }
    const bytes = await getObjectBytes(v.s3Key);
    reply.header('Content-Type', v.mime || 'application/octet-stream');
    reply.header('X-Artifact-Seq', String(v.seq));
    return reply.send(bytes);
  });

  app.get('/api/internal/sessions/:id/hydration-scope', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);
    const paths = await new ArtifactLedger(pool).sessionScope(session.id);
    return reply.send({
      sessionId: session.id,
      scope: 'session',
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      paths,
    });
  });

  await app.register(async (capture) => {
    capture.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );
    capture.post('/api/internal/sessions/:id/artifacts/capture', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const path = (req.query as { path?: string }).path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'bad_query', message: 'valid path required' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const access = await sessionArtifactAccess(session.id);
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
        sessionId: session.id,
        channelId: session.channelId,
        readableChannelIds: access.readableChannelIds,
      });
      if (!canonicalPath) return;
      if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
        return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
      }

      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }
      const isDelete = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const author = `node:${id}`;
      const result = isDelete
        ? await writeBackDelete({
            pool,
            channelId: session.channelId,
            sessionId: session.id,
            path: canonicalPath,
            author,
            ...(baseSeq == null ? {} : { baseSeq }),
          })
        : await writeBackArtifact({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            channelId: session.channelId,
            sessionId: session.id,
            path: canonicalPath,
            bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            mime: normalizeMime(firstHeader(req.headers['content-type'])),
            author,
            ...(baseSeq == null ? {} : { baseSeq }),
          });
      if (!result.ok) {
        return reply.code(409).send({
          error: result.reason,
          ...(result.baseSeq != null ? { baseSeq: result.baseSeq } : {}),
          ...(result.latestSeq != null ? { latestSeq: result.latestSeq } : {}),
        });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });

  await app.register(async (captureStream) => {
    captureStream.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    captureStream.post('/api/internal/sessions/:id/artifacts/capture-stream', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const path = (req.query as { path?: string }).path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'bad_query', message: 'valid path required' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const access = await sessionArtifactAccess(session.id);
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
        sessionId: session.id,
        channelId: session.channelId,
        readableChannelIds: access.readableChannelIds,
      });
      if (!canonicalPath) return;
      if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
        return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
      }

      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }

      const mime = normalizeMime(firstHeader(req.headers['content-type']));
      const source = isReadableStream(req.body) ? req.body : Readable.from(Buffer.alloc(0));
      const stagingKey = `cas-staging/${randomBytes(16).toString('hex')}`;
      let stagingDeleted = false;
      try {
        const hash = createHash('sha256');
        let sizeBytes = 0;
        const sampleChunks: Buffer[] = [];
        let sampleBytes = 0;
        const hashingStream = new Transform({
          transform(chunk, encoding, callback) {
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : typeof chunk === 'string'
                ? Buffer.from(chunk, encoding)
                : Buffer.from(chunk as Uint8Array);
            hash.update(bytes);
            sizeBytes += bytes.byteLength;
            if (sampleBytes < 8192) {
              const next = bytes.subarray(0, Math.min(bytes.byteLength, 8192 - sampleBytes));
              sampleChunks.push(next);
              sampleBytes += next.byteLength;
            }
            callback(null, chunk);
          },
        });
        const upload = uploadObjectStream(stagingKey, hashingStream, mime);
        await Promise.all([pipeline(source, hashingStream), upload]);

        const sha = hash.digest('hex');
        const finalKey = casBlobKey(sha);
        const classification = classifyMedia(Buffer.concat(sampleChunks), {
          declaredMime: mime,
          filename: canonicalPath,
        });
        await copyObject(stagingKey, finalKey);
        await deleteObject(stagingKey);
        stagingDeleted = true;

        const ledger = new ArtifactLedger(pool);
        await withTx(pool, async (client) => {
          await ledger.upsertBlob(client, {
            sha256: sha,
            sizeBytes,
            mime,
            s3Key: finalKey,
            classification,
          });
        });
        const prior = await pool.query(
          `SELECT 1
             FROM sessions s
             JOIN artifacts a ON a.workspace_id = s.workspace_id
            WHERE s.id = $1 AND a.path = $2
            LIMIT 1`,
          [session.id, canonicalPath],
        );
        const result = await ledger.commitVersion({
          sessionId: session.id,
          channelId: session.channelId,
          path: canonicalPath,
          blobSha: sha,
          sizeBytes,
          mime,
          kind: prior.rows[0] ? 'modified' : 'created',
          mergeClass: 'immutable-data',
          author: `node:${id}`,
          ...(baseSeq == null ? {} : { baseSeq }),
        });
        if (!result.ok) {
          return reply.code(409).send({ error: 'stale_base', latestSeq: result.latestSeq, baseSeq: result.baseSeq });
        }
        enqueueThumbnailGeneration({
          pool,
          sourceSha: sha,
          mime: classification.detectedMime,
          mediaKind: classification.mediaKind,
          s3Key: finalKey,
          logger: app.log,
        });
        return reply.send({ seq: result.seq, status: 'normal' });
      } finally {
        if (!stagingDeleted) {
          await deleteObject(stagingKey).catch(() => {});
        }
      }
    });
  });

  app.post('/api/internal/sessions/:id/artifacts/commit-group', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      group_id?: unknown;
      files?: unknown;
    };
    const badManifest = (message: string) => reply.code(400).send({ error: 'bad_manifest', message });
    if (typeof body.group_id !== 'string' || body.group_id.length === 0) {
      return badManifest('group_id is required');
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return badManifest('files must be a non-empty array');
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);

    const files: CommitVersionGroupFile[] = [];
    const seenPaths = new Set<string>();
    for (const raw of body.files) {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return badManifest('each file must be an object');
      }
      const file = raw as {
        path?: unknown;
        blob_sha?: unknown;
        size_bytes?: unknown;
        mime?: unknown;
        base_seq?: unknown;
        kind?: unknown;
        merge_class?: unknown;
      };
      if (typeof file.path !== 'string' || file.path.length === 0) {
        return badManifest('valid path required');
      }
      let path: string;
      try {
        path = canonicalizeSessionArtifactPath(file.path, {
          sessionId: session.id,
          channelId: session.channelId,
          readableChannelIds: access.readableChannelIds,
        });
      } catch (err) {
        if (err instanceof InvalidArtifactPathError) return badManifest(err.message);
        throw err;
      }
      if (!artifactPathInRoots(path, access.writableRoots)) {
        return badManifest('artifact path is not writable');
      }
      if (seenPaths.has(path)) return badManifest('duplicate path');
      seenPaths.add(path);
      if (file.kind !== 'created' && file.kind !== 'modified' && file.kind !== 'deleted') {
        return badManifest('kind must be created, modified, or deleted');
      }
      const blobSha = file.blob_sha;
      if (file.kind === 'deleted') {
        if (blobSha !== null) return badManifest('deleted files must use blob_sha null');
      } else if (typeof blobSha !== 'string' || blobSha.length === 0) {
        return badManifest('created and modified files require blob_sha');
      }
      if (!Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 0) {
        return badManifest('size_bytes must be a non-negative integer');
      }
      if (typeof file.mime !== 'string' || file.mime.length === 0) {
        return badManifest('mime is required');
      }
      let baseSeq: number | null | undefined;
      if (file.base_seq === null || file.base_seq === undefined) {
        baseSeq = file.base_seq;
      } else if (Number.isSafeInteger(file.base_seq) && (file.base_seq as number) > 0) {
        baseSeq = file.base_seq as number;
      } else {
        return badManifest('base_seq must be a positive integer or null');
      }
      let mergeClass: CommitVersionGroupFile['mergeClass'];
      if (file.merge_class !== undefined) {
        if (
          file.merge_class !== 'immutable-data' &&
          file.merge_class !== 'mergeable-doc' &&
          file.merge_class !== 'derived-output'
        ) {
          return badManifest('merge_class is invalid');
        }
        mergeClass = file.merge_class;
      }
      files.push({
        path,
        blobSha: file.kind === 'deleted' ? null : (blobSha as string),
        sizeBytes: file.size_bytes as number,
        mime: normalizeMime(file.mime),
        baseSeq,
        kind: file.kind,
        ...(mergeClass === undefined ? {} : { mergeClass }),
      });
    }

    const result = await new ArtifactLedger(pool).commitVersionGroup({
      sessionId: session.id,
      channelId: session.channelId,
      groupId: body.group_id,
      author: `node:${id}`,
      files,
    });
    if (!result.ok) return reply.code(409).send(result);
    for (const file of files) {
      if (file.blobSha == null || file.kind === 'deleted') continue;
      const classification = classifyMedia(Buffer.alloc(0), {
        declaredMime: file.mime,
        filename: file.path,
      });
      enqueueThumbnailGeneration({
        pool,
        sourceSha: file.blobSha,
        mime: classification.detectedMime,
        mediaKind: classification.mediaKind,
        logger: app.log,
      });
    }
    return reply.send(result);
  });
}
