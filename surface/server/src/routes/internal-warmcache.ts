import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';
import {
  bumpWarmcacheLastHydrated,
  loadWarmcacheBlob,
  loadWarmcacheManifest,
  MAX_WARMCACHE_BLOB_BYTES,
  MAX_WARMCACHE_MANIFEST_ENTRIES,
  normalizeWarmcacheSha,
  registerWarmcacheManifest,
  storeWarmcacheBlob,
  type WarmcacheEntry,
} from '../warmcache-store.js';

type InternalSessionRef = {
  id: string;
  channelId: string;
  workspaceId: string;
};

export interface InternalWarmcacheRouteDeps {
  pool: Db;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null>;
}

export async function registerInternalWarmcacheRoutes(
  app: FastifyInstance,
  deps: InternalWarmcacheRouteDeps,
): Promise<void> {
  const { pool, requireCaptureKey, resolveInternalSessionRef } = deps;

  const warmcacheWorkspaceExists = async (id: string): Promise<boolean> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const r = await pool.query('SELECT 1 FROM workspaces WHERE id = $1', [id]);
    return r.rows.length > 0;
  };

  app.get('/api/internal/cache/blob', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const sha256 = normalizeWarmcacheSha((req.query as { sha256?: string }).sha256);
    const bytes = await loadWarmcacheBlob(pool, { getObjectBytes }, sha256);
    if (!bytes) return reply.code(404).send({ error: 'not_found', message: 'warm-cache blob not found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Warmcache-Sha256', sha256);
    return reply.send(bytes);
  });

  await app.register(async (warmcacheBlob) => {
    warmcacheBlob.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_WARMCACHE_BLOB_BYTES },
      (_req, body, done) => done(null, body),
    );
    warmcacheBlob.put('/api/internal/cache/blob', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const sha256 = (req.query as { sha256?: string }).sha256 ?? '';
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await storeWarmcacheBlob(pool, { uploadObject, headObject }, { sha256, bytes });
      return reply.send(result);
    });
  });

  app.put('/api/internal/cache/manifest', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const body = (req.body ?? {}) as {
      workspace_id?: unknown;
      lockfile_hash?: unknown;
      kind?: unknown;
      entries?: unknown;
    };
    const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : '';
    if (!(await warmcacheWorkspaceExists(workspaceId))) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }
    const entries = Array.isArray(body.entries) ? (body.entries as WarmcacheEntry[]) : [];
    if (entries.length > MAX_WARMCACHE_MANIFEST_ENTRIES) {
      return reply.code(413).send({ error: 'manifest_too_large', message: 'too many cache entries' });
    }
    const result = await registerWarmcacheManifest(pool, {
      workspaceId,
      lockfileHash: String(body.lockfile_hash ?? ''),
      kind: String(body.kind ?? ''),
      entries,
    });
    return reply.send(result);
  });

  app.get('/api/internal/cache/hydration', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const q = req.query as { workspace_id?: string; lockfile_hash?: string; kind?: string };
    const workspaceId = typeof q.workspace_id === 'string' ? q.workspace_id : '';
    if (!(await warmcacheWorkspaceExists(workspaceId))) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }
    const entries = await loadWarmcacheManifest(pool, {
      workspaceId,
      lockfileHash: String(q.lockfile_hash ?? ''),
      kind: String(q.kind ?? ''),
    });
    try {
      await bumpWarmcacheLastHydrated(pool, {
        workspaceId,
        lockfileHash: String(q.lockfile_hash ?? ''),
        kind: String(q.kind ?? ''),
      });
    } catch (err) {
      req.log.warn({ err, workspaceId }, 'warm-cache last hydration bump failed');
    }
    return reply.send({
      workspaceId,
      scope: 'warmcache',
      kind: String(q.kind ?? ''),
      lockfileHash: String(q.lockfile_hash ?? ''),
      entries,
    });
  });

  app.get('/api/internal/sessions/:id/cache/hydration', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const q = req.query as { lockfile_hash?: string; kind?: string };
    const entries = await loadWarmcacheManifest(pool, {
      workspaceId: session.workspaceId,
      lockfileHash: String(q.lockfile_hash ?? ''),
      kind: String(q.kind ?? ''),
    });
    try {
      await bumpWarmcacheLastHydrated(pool, {
        workspaceId: session.workspaceId,
        lockfileHash: String(q.lockfile_hash ?? ''),
        kind: String(q.kind ?? ''),
      });
    } catch (err) {
      req.log.warn({ err, workspaceId: session.workspaceId }, 'warm-cache last hydration bump failed');
    }
    return reply.send({
      workspaceId: session.workspaceId,
      scope: 'warmcache',
      kind: String(q.kind ?? ''),
      lockfileHash: String(q.lockfile_hash ?? ''),
      entries,
    });
  });

  app.put('/api/internal/sessions/:id/cache/manifest', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const body = (req.body ?? {}) as { lockfile_hash?: unknown; kind?: unknown; entries?: unknown };
    const entries = Array.isArray(body.entries) ? (body.entries as WarmcacheEntry[]) : [];
    if (entries.length > MAX_WARMCACHE_MANIFEST_ENTRIES) {
      return reply.code(413).send({ error: 'manifest_too_large', message: 'too many cache entries' });
    }
    const result = await registerWarmcacheManifest(pool, {
      workspaceId: session.workspaceId,
      lockfileHash: String(body.lockfile_hash ?? ''),
      kind: String(body.kind ?? ''),
      entries,
    });
    return reply.send(result);
  });
}
