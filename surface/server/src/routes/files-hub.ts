import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ArtifactLedger } from '../artifact-ledger.js';
import type { Db } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import { isWorkspaceMember } from '../membership.js';
import { getObjectStream, presignGet } from '../s3.js';
import { sanitizeFilename } from '../safe-filename.js';

type HubFileListQuery = {
  origin?: Array<'upload' | 'agent' | 'workspace'>;
  mediaKind?: string[];
  channelId?: string;
  sessionId?: string;
  label?: string;
  starred?: boolean;
  q?: string;
  includeDeleted?: boolean;
  includeScratch?: boolean;
  sort?: 'recent' | 'name' | 'size';
  cursor?: string;
  limit?: number;
};

export interface FilesHubRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.flatMap((item) => stringArray(item) ?? []);
  if (typeof value !== 'string') return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolQuery(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function parseListQuery(raw: Record<string, unknown>): HubFileListQuery {
  return {
    ...(stringArray(raw.origin) ? { origin: stringArray(raw.origin) as HubFileListQuery['origin'] } : {}),
    ...(stringArray(raw.mediaKind) ? { mediaKind: stringArray(raw.mediaKind) } : {}),
    ...(typeof raw.channelId === 'string' ? { channelId: raw.channelId } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}),
    ...(boolQuery(raw.starred) != null ? { starred: boolQuery(raw.starred) } : {}),
    ...(typeof raw.q === 'string' && raw.q.trim() ? { q: raw.q.trim().slice(0, 200) } : {}),
    ...(boolQuery(raw.includeDeleted) != null ? { includeDeleted: boolQuery(raw.includeDeleted) } : {}),
    ...(boolQuery(raw.includeScratch) != null ? { includeScratch: boolQuery(raw.includeScratch) } : {}),
    ...(raw.sort === 'name' || raw.sort === 'size' || raw.sort === 'recent' ? { sort: raw.sort } : {}),
    ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
    ...(raw.limit != null ? { limit: Number(raw.limit) } : {}),
  };
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().slice(0, 64);
  return label.length > 0 && !label.includes('\0') ? label : null;
}

function normalizeRename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = sanitizeFilename(basename(value.replace(/\\/g, '/')).trim()).slice(0, 200);
  if (!name || name === '.' || name === '..' || name.includes('/')) return null;
  return name;
}

function shouldProxyContent(file: { mime: string | null; mediaKind: string | null; sizeBytes: number | null }): boolean {
  if (file.mediaKind === 'video' || file.mediaKind === 'audio') return true;
  return (file.mime ?? '').toLowerCase() === 'application/pdf' && (file.sizeBytes ?? 0) >= 5 * 1024 * 1024;
}

function parseRangeHeader(
  range: unknown,
  sizeBytes: number | null,
): { header: string; start: number; end: number; length: number } | null | false {
  if (typeof range !== 'string' || range.length === 0) return null;
  if (sizeBytes == null || sizeBytes < 0) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return false;
  const startRaw = match[1]!;
  const endRaw = match[2]!;
  if (!startRaw && !endRaw) return false;
  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return false;
    start = Math.max(sizeBytes - suffix, 0);
    end = sizeBytes - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : sizeBytes - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  }
  if (start < 0 || start >= sizeBytes || end < start) return false;
  end = Math.min(end, sizeBytes - 1);
  return {
    header: `bytes=${start}-${end}`,
    start,
    end,
    length: end - start + 1,
  };
}

async function requireReadableArtifact(
  ledger: ArtifactLedger,
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRef,
): Promise<string | null> {
  const { artifactId } = req.params as { artifactId: string };
  if (!isUuid(artifactId)) {
    reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    return null;
  }
  const access = await ledger.artifactReadableByUser(artifactId, user.id);
  if (!access) {
    reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    return null;
  }
  return artifactId;
}

export async function registerFilesHubRoutes(app: FastifyInstance, deps: FilesHubRouteDeps): Promise<void> {
  const { pool, requireUser } = deps;
  const ledger = new ArtifactLedger(pool);

  app.get('/api/workspaces/:workspaceId/files', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { workspaceId } = req.params as { workspaceId: string };
    if (!isUuid(workspaceId) || !(await isWorkspaceMember(pool, user.id, workspaceId))) {
      return reply.code(404).send({ error: 'workspace_not_found', message: 'workspace not found' });
    }
    return ledger.listWorkspaceFiles({
      workspaceId,
      userId: user.id,
      query: parseListQuery((req.query ?? {}) as Record<string, unknown>),
    });
  });

  app.get('/api/channels/:channelId/files', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { channelId } = req.params as { channelId: string };
    if (!isUuid(channelId) || !(await canAccessChannel(pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const channel = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      channelId,
    ]);
    const workspaceId = channel.rows[0]?.workspace_id;
    if (!workspaceId) return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    const query = parseListQuery((req.query ?? {}) as Record<string, unknown>);
    return ledger.listChannelFiles({ workspaceId, channelId, userId: user.id, query });
  });

  app.post('/api/files/:artifactId/labels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const label = normalizeLabel((req.body as { label?: unknown } | undefined)?.label);
    if (!label) return reply.code(400).send({ error: 'bad_request', message: 'label is required' });
    return { artifactId, labels: await ledger.addLabel(artifactId, label, user.id) };
  });

  app.delete('/api/files/:artifactId/labels/:label', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const label = normalizeLabel((req.params as { label?: unknown }).label);
    if (!label) return reply.code(400).send({ error: 'bad_request', message: 'label is required' });
    return { artifactId, labels: await ledger.removeLabel(artifactId, label) };
  });

  app.post('/api/files/:artifactId/star', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    return { artifactId, starred: await ledger.setStar(artifactId, user.id, true) };
  });

  app.delete('/api/files/:artifactId/star', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    return { artifactId, starred: await ledger.setStar(artifactId, user.id, false) };
  });

  app.patch('/api/files/:artifactId', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'you cannot rename this file' });
    }
    const name = normalizeRename((req.body as { name?: unknown } | undefined)?.name);
    if (!name) return reply.code(400).send({ error: 'bad_request', message: 'name is required' });
    try {
      const renamed = await ledger.renameArtifact(artifactId, name);
      return { artifactId, ...renamed };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'path_exists', message: 'a file already exists at that path' });
      }
      throw err;
    }
  });

  app.delete('/api/files/:artifactId', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'you cannot delete this file' });
    }
    await ledger.softDeleteArtifact(artifactId, `human:${user.id}`);
    return { artifactId, tombstoned: true };
  });

  app.post('/api/files/:artifactId/restore', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'you cannot restore this file' });
    }
    if (!(await ledger.restoreArtifact(artifactId))) {
      return reply.code(409).send({ error: 'not_restorable', message: 'file has no restorable version' });
    }
    return { artifactId, tombstoned: false };
  });

  app.get('/api/files/artifact/:artifactId/content', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const file = await ledger.artifactContentById(artifactId);
    if (!file) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    if (file.tombstoned || file.kind === 'deleted') {
      return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
    }
    if (!file.s3Key || !file.blobSha) {
      return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
    }
    const filename = basename(file.path) || 'artifact';
    if (!shouldProxyContent(file)) {
      return reply.redirect(await presignGet(file.s3Key, filename, true), 302);
    }

    const parsedRange = parseRangeHeader(req.headers.range, file.sizeBytes);
    if (parsedRange === false) {
      if (file.sizeBytes != null) reply.header('Content-Range', `bytes */${file.sizeBytes}`);
      return reply.code(416).send({ error: 'invalid_range', message: 'Range header is not satisfiable' });
    }
    const object = await getObjectStream(file.s3Key, parsedRange?.header);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', object.contentType ?? file.mime ?? 'application/octet-stream');
    reply.header('X-Artifact-Seq', String(file.seq));
    reply.header('X-Artifact-Sha', file.blobSha);
    if (parsedRange) {
      reply.header('Content-Range', object.contentRange ?? `bytes ${parsedRange.start}-${parsedRange.end}/${file.sizeBytes}`);
      reply.header('Content-Length', String(object.contentLength ?? parsedRange.length));
      return reply.code(206).send(object.stream);
    }
    if (object.contentLength != null || file.sizeBytes != null) {
      reply.header('Content-Length', String(object.contentLength ?? file.sizeBytes));
    }
    return reply.send(object.stream);
  });

  app.get('/api/files/artifact/:artifactId/thumbnail', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const file = await ledger.artifactThumbnailById(artifactId);
    if (!file) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    if (file.tombstoned || file.kind === 'deleted') {
      return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
    }
    if (!file.thumbnailSha || !file.s3Key) {
      return reply.code(404).send({ error: 'thumbnail_not_found', message: 'thumbnail not found' });
    }
    const filename = `${basename(file.path) || 'artifact'}-thumbnail`;
    return reply.redirect(await presignGet(file.s3Key, filename, true), 302);
  });
}
