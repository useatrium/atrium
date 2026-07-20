import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import type { deleteObject, ensureBucket, presignGet, uploadObject } from '../s3.js';

const MAX_AVATAR_BYTES = Math.min(config.maxUploadBytes, 5 * 1024 * 1024);
const AVATAR_MIME = 'image/webp';
const SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

interface AvatarStorage {
  ensureBucket: typeof ensureBucket;
  deleteObject: typeof deleteObject;
  presignGet: typeof presignGet;
  uploadObject: typeof uploadObject;
}

export interface AvatarRouteDeps {
  pool: Db;
  fileStorage: AvatarStorage;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function normalizeContentType(value: unknown): string {
  return String(value ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

async function canViewUser(pool: Db, viewerId: string, targetId: string): Promise<boolean> {
  const res = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM workspace_members mine
         JOIN workspace_members theirs ON theirs.workspace_id = mine.workspace_id
        WHERE mine.user_id = $1
          AND theirs.user_id = $2
     ) AS ok`,
    [viewerId, targetId],
  );
  return res.rows[0]?.ok === true;
}

async function avatarBytes(source: Buffer): Promise<Buffer> {
  return sharp(source, { animated: false, failOn: 'truncated' })
    .rotate()
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .webp({ quality: 86 })
    .toBuffer();
}

export function registerAvatarRoutes(app: FastifyInstance, deps: AvatarRouteDeps): void {
  const { pool, fileStorage, requireUser } = deps;

  app.addContentTypeParser(
    /^image\/[\w.+-]+$/i,
    { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES },
    (_req, body, done) => {
      done(null, Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
  );

  app.put('/api/me/avatar', { bodyLimit: MAX_AVATAR_BYTES }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const contentType = normalizeContentType(req.headers['content-type']);
    if (!SOURCE_TYPES.has(contentType)) {
      return reply
        .code(415)
        .send({ error: 'unsupported_media_type', message: 'avatar must be JPEG, PNG, GIF, or WebP' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.byteLength === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'avatar image required' });
    }
    if (body.byteLength > MAX_AVATAR_BYTES) {
      return reply.code(413).send({ error: 'file_too_large', message: 'avatar exceeds 5MB' });
    }

    let processed: Buffer;
    try {
      processed = await avatarBytes(body);
    } catch {
      return reply.code(400).send({ error: 'invalid_image', message: 'avatar image could not be decoded' });
    }

    try {
      await fileStorage.ensureBucket();
    } catch {
      return reply.code(503).send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }

    const previous = await pool.query<{ avatar_s3_key: string | null; avatar_version: number }>(
      'SELECT avatar_s3_key, avatar_version FROM users WHERE id = $1',
      [user.id],
    );
    const nextVersion = Number(previous.rows[0]?.avatar_version ?? 0) + 1;
    const key = `avatars/${user.id}/v${nextVersion}-${randomUUID()}.webp`;
    await fileStorage.uploadObject(key, processed, AVATAR_MIME);

    await pool.query(
      `UPDATE users
          SET avatar_s3_key = $2,
              avatar_content_type = $3,
              avatar_version = $4,
              avatar_updated_at = now()
        WHERE id = $1`,
      [user.id, key, AVATAR_MIME, nextVersion],
    );

    const oldKey = previous.rows[0]?.avatar_s3_key;
    if (oldKey && oldKey !== key) void fileStorage.deleteObject(oldKey).catch(() => {});
    return reply.send({ avatarUrl: `/api/users/${user.id}/avatar?v=${nextVersion}`, avatarVersion: nextVersion });
  });

  app.delete('/api/me/avatar', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const previous = await pool.query<{ avatar_s3_key: string | null; avatar_version: number }>(
      'SELECT avatar_s3_key, avatar_version FROM users WHERE id = $1',
      [user.id],
    );
    const nextVersion = Number(previous.rows[0]?.avatar_version ?? 0) + 1;
    await pool.query(
      `UPDATE users
          SET avatar_s3_key = NULL,
              avatar_content_type = NULL,
              avatar_version = $2,
              avatar_updated_at = NULL
        WHERE id = $1`,
      [user.id, nextVersion],
    );
    const oldKey = previous.rows[0]?.avatar_s3_key;
    if (oldKey) void fileStorage.deleteObject(oldKey).catch(() => {});
    return reply.send({ avatarUrl: null, avatarVersion: nextVersion });
  });

  app.get('/api/users/:id/avatar', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id) || !(await canViewUser(pool, user.id, id))) {
      return reply.code(404).send({ error: 'avatar_not_found', message: 'avatar not found' });
    }
    const res = await pool.query<{ avatar_s3_key: string | null; avatar_content_type: string | null }>(
      'SELECT avatar_s3_key, avatar_content_type FROM users WHERE id = $1',
      [id],
    );
    const avatar = res.rows[0];
    if (!avatar?.avatar_s3_key) {
      return reply.code(404).send({ error: 'avatar_not_found', message: 'avatar not found' });
    }
    const url = await fileStorage.presignGet(avatar.avatar_s3_key, 'avatar.webp', true);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.redirect(url, 302);
  });
}
