import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { canAccessFile, type UserRef } from '../events.js';
import { FILE_URL_TTL_S, fileSignature, verifyFileSignature } from '../filesign.js';
import type { deleteObject, ensureBucket, presignGet, presignPut } from '../s3.js';

interface FileStorage {
  ensureBucket: typeof ensureBucket;
  deleteObject: typeof deleteObject;
  presignGet: typeof presignGet;
  presignPut: typeof presignPut;
}

export interface UploadRouteDeps {
  pool: Db;
  fileStorage: FileStorage;
  secret: string;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  activeWorkspaceIdFor(userId: string): Promise<string | null>;
  noWorkspace(reply: FastifyReply): FastifyReply;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function uploadContentType(value: unknown): string {
  return typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
}

function optionalSha256(value: unknown): string | null | false {
  if (typeof value !== 'string' || value.length === 0) return null;
  const hash = value.toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : false;
}

function positiveDimension(value: unknown): number | null {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null;
}

export function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDeps): void {
  const { pool, fileStorage, secret, requireUser, activeWorkspaceIdFor, noWorkspace } = deps;

  app.post('/api/uploads', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      filename?: string;
      contentType?: string;
      size?: number;
      width?: number;
      height?: number;
      contentHash?: string;
    };
    const filename =
      String(body.filename ?? '')
        .trim()
        .slice(0, 200) || 'file';
    const contentType = uploadContentType(body.contentType);
    const contentHash = optionalSha256(body.contentHash);
    if (contentHash === false) {
      return reply.code(400).send({ error: 'bad_request', message: 'contentHash must be sha-256 hex' });
    }
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'size required' });
    }
    if (size > config.maxUploadBytes) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `file exceeds ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`,
      });
    }
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    try {
      await fileStorage.ensureBucket();
    } catch {
      return reply.code(503).send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }

    if (contentHash != null) {
      const existing = await pool.query<{ id: string; s3_key: string }>(
        `SELECT id, s3_key
           FROM files
          WHERE uploader_id = $1 AND content_hash = $2 AND size_bytes = $3
          ORDER BY created_at ASC
          LIMIT 1`,
        [user.id, contentHash, size],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const uploadUrl = await fileStorage.presignPut(row.s3_key, contentType);
        return reply.send({ fileId: row.id, uploadUrl, existing: true });
      }
    }

    const fileId = randomUUID();
    const s3Key = `${fileId}/${filename}`;
    await pool.query(
      `INSERT INTO files (id, workspace_id, uploader_id, filename, content_type, size_bytes, width, height, s3_key, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        fileId,
        workspaceId,
        user.id,
        filename,
        contentType,
        size,
        positiveDimension(body.width),
        positiveDimension(body.height),
        s3Key,
        contentHash,
      ],
    );
    const uploadUrl = await fileStorage.presignPut(s3Key, contentType);
    return reply.code(201).send({ fileId, uploadUrl, existing: false });
  });

  app.post('/api/uploads/:fileId/refresh', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { fileId } = req.params as { fileId: string };
    if (!isUuid(fileId)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const row = await pool.query<{ content_type: string; s3_key: string }>(
      `SELECT content_type, s3_key FROM files WHERE id = $1 AND uploader_id = $2`,
      [fileId, user.id],
    );
    const file = row.rows[0];
    if (!file) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    try {
      await fileStorage.ensureBucket();
    } catch {
      return reply.code(503).send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }
    const uploadUrl = await fileStorage.presignPut(file.s3_key, file.content_type);
    return reply.send({ uploadUrl });
  });

  app.get('/api/files/:id/url', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    if (!(await canAccessFile(pool, user.id, id))) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const expires = Math.floor(Date.now() / 1000) + FILE_URL_TTL_S;
    const sig = fileSignature(id, expires, secret);
    return {
      url: `/api/files/${id}?expires=${expires}&sig=${encodeURIComponent(sig)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const q = (req.query ?? {}) as { expires?: unknown; sig?: unknown };
    const signed =
      typeof q.sig === 'string' &&
      typeof q.expires === 'string' &&
      verifyFileSignature(id, Number(q.expires), q.sig, secret);
    if (!signed) {
      const user = requireUser(req, reply);
      if (!user) return;
      if (!(await canAccessFile(pool, user.id, id))) {
        // Not an upload this user can read. Mobile clients funnel ledger
        // artifact ids through this URL too — hand those to the artifact
        // content route, which re-checks ACL and 404-hides on its own.
        return reply.redirect(`/api/files/artifact/${id}/content`, 302);
      }
    }
    const res = await pool.query<{
      filename: string;
      content_type: string;
      s3_key: string;
      content_hash: string | null;
    }>('SELECT filename, content_type, s3_key, content_hash FROM files WHERE id = $1', [id]);
    const file = res.rows[0];
    if (!file || !file.s3_key) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    if (file.content_hash) {
      const tombstone = await pool.query<{ tombstoned: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM events e
             JOIN artifacts a
               ON a.workspace_id = e.workspace_id
              AND a.path LIKE ('shared/channels/' || e.channel_id::text || '/uploads/%')
             JOIN artifact_versions v ON v.artifact_id = a.id
            WHERE e.type = 'message.posted'
              AND jsonb_typeof(e.payload->'attachments') = 'array'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(e.payload->'attachments') att
                 WHERE att->>'id' = $1
              )
              AND v.blob_sha = $2
              AND a.tombstoned_at IS NOT NULL
         ) AS tombstoned`,
        [id, file.content_hash],
      );
      if (tombstone.rows[0]?.tombstoned) {
        return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
      }
    }
    const inline = file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
    const url = await fileStorage.presignGet(file.s3_key, file.filename, inline);
    return reply.redirect(url, 302);
  });
}
