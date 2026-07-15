import { basename } from 'node:path';
import { parseAgentPathHref } from '@atrium/surface-client/agent-paths';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ArtifactLedger, type VersionKind, type VersionRef, type VersionStatus } from '../artifact-ledger.js';
import { loadConflictDetailById } from '../artifact-conflict.js';
import { firstHeader, normalizeMime, parseBaseSeq } from '../artifact-route-utils.js';
import { classifyScope } from '../artifact-scope.js';
import { isTopLevelDocumentNavigation, sendArtifactPreview } from '../artifact-preview.js';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import { classifyMedia } from '../media-classifier.js';
import { isWorkspaceMember } from '../membership.js';
import { getObjectBytes, getObjectStream, headObject, presignGet, uploadObject } from '../s3.js';
import { sanitizeFilename } from '../safe-filename.js';
import { ensureThumbnailForBlobDeduped } from '../thumbnails.js';
import { writeBackArtifactById, writeBackDeleteById, type WriteBackArtifactByIdResult } from '../artifact-writeback.js';

type FileCategory = 'image' | 'doc' | 'data' | 'app' | 'upload';
const FILE_CATEGORY_VALUES: readonly FileCategory[] = ['image', 'doc', 'data', 'app', 'upload'];

type HubFileListQuery = {
  origin?: Array<'upload' | 'agent' | 'workspace'>;
  mediaKind?: string[];
  category?: FileCategory;
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

function sendWritebackResult(reply: FastifyReply, result: WriteBackArtifactByIdResult) {
  if (result.ok) return reply.send({ seq: result.seq, status: result.status });
  if (result.reason === 'gone') return reply.code(410).send({ error: 'gone' });
  if (result.reason === 'binary_not_editable') {
    return reply.code(415).send({ error: 'binary_not_editable', mediaKind: result.mediaKind });
  }
  return reply.code(409).send({
    error: result.reason,
    ...(result.baseSeq != null ? { baseSeq: result.baseSeq } : {}),
    ...(result.latestSeq != null ? { latestSeq: result.latestSeq } : {}),
  });
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
    ...(typeof raw.category === 'string' && FILE_CATEGORY_VALUES.includes(raw.category as FileCategory)
      ? { category: raw.category as FileCategory }
      : {}),
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

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function shouldProxyContent(file: {
  mime: string | null;
  mediaKind: string | null;
  sizeBytes: number | null;
}): boolean {
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
  if (!isUuid(artifactId) || !(await ledger.artifactReadableByUser(artifactId, user.id))) {
    reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    return null;
  }
  return artifactId;
}

async function requireManageableArtifact(
  ledger: ArtifactLedger,
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRef,
) {
  const artifactId = await requireReadableArtifact(ledger, req, reply, user);
  if (!artifactId) return null;
  if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return artifactId;
}

function requireBaseSeq(req: FastifyRequest, reply: FastifyReply): number | null {
  const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
  if (baseSeq === false) {
    reply.code(400).send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
    return null;
  }
  if (baseSeq == null) {
    reply.code(409).send({ error: 'base_required' });
    return null;
  }
  return baseSeq;
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

  app.get('/api/files/by-path', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const path = (req.query as { path?: unknown }).path;
    const ref = typeof path === 'string' ? parseAgentPathHref(path) : null;
    if (!ref || ref.kind === 'workspace-relative' || ref.canonicalPath !== path) {
      return reply.code(400).send({ error: 'bad_request', message: 'path must be a canonical artifact path' });
    }

    let workspaceId: string | null = null;
    let listUserId = user.id;
    if (ref.kind === 'shared-channel') {
      const channel = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
        ref.channelId,
      ]);
      workspaceId = channel.rows[0]?.workspace_id ?? null;
      if (!workspaceId) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
      if (!(await canAccessChannel(pool, user.id, ref.channelId))) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    } else if (ref.kind === 'scratch') {
      const session = await pool.query<{ workspace_id: string; channel_id: string; spawned_by: string }>(
        `SELECT workspace_id, channel_id, spawned_by
           FROM sessions
          WHERE id = $1`,
        [ref.sessionId],
      );
      const sessionRow = session.rows[0];
      if (!sessionRow || !(await canAccessChannel(pool, user.id, sessionRow.channel_id))) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      workspaceId = sessionRow.workspace_id;
      // Hub browsing intentionally limits scratch to a session's owner/driver.
      // Resolve with the owner solely to reuse its row mapper after the broader
      // session-read ACL above, then restore requester-specific fields below.
      listUserId = sessionRow.spawned_by;
    } else {
      const workspace = await pool.query<{ workspace_id: string }>(
        `SELECT a.workspace_id
           FROM artifacts a
           JOIN workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = $2
          WHERE a.path = $1
          ORDER BY a.created_at DESC
          LIMIT 1`,
        [ref.canonicalPath, user.id],
      );
      workspaceId = workspace.rows[0]?.workspace_id ?? null;
      if (!workspaceId) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }

    let file = await ledger.workspaceFileByPath({
      workspaceId,
      userId: listUserId,
      path: ref.canonicalPath,
    });
    if (!file) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    if (listUserId !== user.id) {
      const starred = await pool.query('SELECT 1 FROM artifact_stars WHERE artifact_id = $1 AND user_id = $2', [
        file.artifactId,
        user.id,
      ]);
      file = { ...file, starred: (starred.rowCount ?? 0) > 0 };
    }
    return file;
  });

  // One hub row by artifact id, tombstoned included — the files surfaces use
  // it to reveal a deep-linked file that the current filters/page don't load.
  // (The bare GET /api/files/:id path belongs to the legacy uploads route.)
  app.get('/api/files/:artifactId/locator', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const file = await ledger.fileById({ artifactId, userId: user.id });
    if (!file) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    return file;
  });

  app.get('/api/files/:artifactId/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const res = await pool.query<{
      seq: number;
      author: string;
      kind: VersionKind;
      status: VersionStatus;
      created_at: Date | string;
      size_bytes: number | string | null;
      mime: string | null;
      is_latest: boolean;
    }>(
      `SELECT v.seq, v.author, v.kind, v.status, v.created_at,
              b.size_bytes, b.mime,
              COALESCE(p.seq = v.seq, false) AS is_latest
         FROM artifact_versions v
         LEFT JOIN artifact_pointers p ON p.artifact_id = v.artifact_id AND p.name = 'latest'
         LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
        WHERE v.artifact_id = $1
        ORDER BY v.seq DESC`,
      [artifactId],
    );
    return {
      versions: res.rows.map((row) => ({
        seq: row.seq,
        author: row.author,
        kind: row.kind,
        status: row.status,
        createdAt: isoDate(row.created_at),
        sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
        mime: row.mime,
        isLatest: row.is_latest,
      })),
    };
  });

  app.get('/api/files/:artifactId/preview', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (isTopLevelDocumentNavigation(req)) {
      return reply.code(403).send({ error: 'preview_embed_required', message: 'artifact previews must be embedded' });
    }
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const artifact = await ledger.artifactById(artifactId);
    if (!artifact) return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    if (artifact.tombstoned) {
      return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
    }

    const q = req.query as { at?: string; renderer?: string };
    const at = q.at ?? 'latest';
    let ref: VersionRef;
    if (at === 'latest') {
      const res = await ledger.serveResolutionByArtifactId(artifactId);
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      reply.header('X-Artifact-Seq', String(res.servedSeq));
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      ref = { seq: res.servedSeq };
    } else if (/^\d+$/.test(at)) {
      ref = { seq: Number(at) };
    } else {
      return reply.code(400).send({ error: 'bad_query', message: 'at must be "latest" or a version seq' });
    }

    const version = await ledger.resolveVersionByArtifactId(artifactId, ref);
    if (!version) return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    if (version.kind === 'deleted' || version.tombstoned) {
      return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
    }
    if (!version.blobSha || !version.s3Key) {
      return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
    }

    const bytes = await getObjectBytes(version.s3Key);
    return sendArtifactPreview(reply, {
      bytes,
      path: artifact.path,
      mime: version.mime,
      rendererHint: q.renderer,
      headers: {
        'X-Artifact-Scope': classifyScope(artifact.path),
        'X-Artifact-Canonical-Path': artifact.path,
        'X-Artifact-Display-Path': artifact.path,
      },
    });
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

  app.post('/api/files/:artifactId/revert', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'you cannot revert this file' });
    }
    const seq = Number((req.body as { seq?: unknown } | undefined)?.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'seq must be a version number' });
    }
    const result = await ledger.revertArtifactToSeq(artifactId, seq, `human:${user.id}`);
    if (!result) {
      return reply.code(409).send({ error: 'not_revertable', message: 'cannot revert to that version' });
    }
    return { artifactId, seq: result.newSeq, tombstoned: false };
  });

  app.register(async (editScope) => {
    editScope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );

    editScope.put('/api/files/:artifactId/content', async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const rawArtifactId = await requireManageableArtifact(ledger, req, reply, user);
      if (!rawArtifactId) return;

      const baseSeq = requireBaseSeq(req, reply);
      if (baseSeq == null) return;

      const current = await ledger.artifactContentById(rawArtifactId);
      if (!current) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (current.tombstoned || current.kind === 'deleted') {
        return reply.code(410).send({ error: 'gone' });
      }
      if (current.isText !== true) {
        return reply.code(415).send({ error: 'binary_not_editable', mediaKind: current.mediaKind ?? 'binary' });
      }

      const body = Buffer.isBuffer(req.body)
        ? req.body
        : req.body instanceof Uint8Array
          ? Buffer.from(req.body)
          : typeof req.body === 'string'
            ? Buffer.from(req.body, 'utf8')
            : Buffer.alloc(0);
      const mime = normalizeMime(firstHeader(req.headers['content-type']));
      const incoming = classifyMedia(body, { declaredMime: mime, filename: current.path });
      if (!incoming.isText) {
        return reply.code(415).send({ error: 'binary_not_editable', mediaKind: incoming.mediaKind });
      }

      const result = await writeBackArtifactById({
        pool,
        storage: { uploadObject, getObjectBytes, headObject },
        artifactId: rawArtifactId,
        bytes: body,
        mime,
        author: `human:${user.id}`,
        baseSeq,
      });
      return sendWritebackResult(reply, result);
    });

    editScope.post('/api/files/:artifactId/resolve', async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const rawArtifactId = await requireManageableArtifact(ledger, req, reply, user);
      if (!rawArtifactId) return;

      const conflict = await ledger.getConflictById(rawArtifactId);
      if (!conflict) {
        return reply.code(409).send({ error: 'no_conflict' });
      }
      const baseSeq = requireBaseSeq(req, reply);
      if (baseSeq == null) return;
      if (baseSeq !== conflict.conflictSeq) {
        return reply.code(409).send({
          error: 'stale_base',
          baseSeq,
          latestSeq: conflict.conflictSeq,
        });
      }

      const stayDeleted = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const result = stayDeleted
        ? await writeBackDeleteById({
            pool,
            artifactId: rawArtifactId,
            author: `human:${user.id}`,
            baseSeq,
          })
        : await writeBackArtifactById({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            artifactId: rawArtifactId,
            bytes: Buffer.isBuffer(req.body)
              ? req.body
              : req.body instanceof Uint8Array
                ? Buffer.from(req.body)
                : typeof req.body === 'string'
                  ? Buffer.from(req.body, 'utf8')
                  : Buffer.alloc(0),
            mime: normalizeMime(firstHeader(req.headers['content-type'])),
            author: `human:${user.id}`,
            baseSeq,
          });
      return sendWritebackResult(reply, result);
    });
  });

  app.get('/api/files/:artifactId/conflict', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    const detail = await loadConflictDetailById(pool, { getObjectBytes }, artifactId);
    if (!detail) {
      return reply.code(404).send({ error: 'no_conflict' });
    }
    return reply.send(detail);
  });

  app.get('/api/files/artifact/:artifactId/content', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const artifactId = await requireReadableArtifact(ledger, req, reply, user);
    if (!artifactId) return;
    // `?at=<seq>` serves a specific prior version's bytes (used by the version-diff view).
    const atRaw = (req.query as { at?: string }).at;
    if (atRaw != null && /^\d+$/.test(atRaw)) {
      const v = await ledger.resolveVersionByArtifactId(artifactId, { seq: Number(atRaw) });
      if (!v || !v.blobSha || !v.s3Key) {
        return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
      }
      const object = await getObjectStream(v.s3Key);
      reply.header('Content-Type', object.contentType ?? v.mime ?? 'application/octet-stream');
      reply.header('X-Artifact-Seq', atRaw);
      if (object.contentLength != null) reply.header('Content-Length', String(object.contentLength));
      return reply.send(object.stream);
    }
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
      reply.header(
        'Content-Range',
        object.contentRange ?? `bytes ${parsedRange.start}-${parsedRange.end}/${file.sizeBytes}`,
      );
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
    let thumbnail = file;
    if (!thumbnail.thumbnailSha || !thumbnail.s3Key) {
      if (file.sourceBlobSha) {
        const source = await pool.query<{
          sha256: string;
          s3_key: string | null;
          mime: string | null;
          media_kind: string | null;
        }>(
          `SELECT sha256, s3_key, mime, media_kind
             FROM cas_blobs
            WHERE sha256 = $1`,
          [file.sourceBlobSha],
        );
        const sourceRow = source.rows[0];
        if (
          sourceRow?.s3_key &&
          (sourceRow.media_kind === 'image' || sourceRow.media_kind === 'pdf' || sourceRow.media_kind === 'video')
        ) {
          const generated = await ensureThumbnailForBlobDeduped({
            pool,
            sourceSha: sourceRow.sha256,
            s3Key: sourceRow.s3_key,
            mime: sourceRow.mime,
            mediaKind: sourceRow.media_kind,
            logger: app.log,
          }).catch((err) => {
            app.log.warn({ err, sourceSha: sourceRow.sha256 }, 'on-demand thumbnail generation failed');
            return null;
          });
          if (generated) {
            thumbnail = (await ledger.artifactThumbnailById(artifactId)) ?? thumbnail;
          }
        }
      }
      if (!thumbnail.thumbnailSha || !thumbnail.s3Key) {
        return reply.code(404).send({ error: 'thumbnail_not_found', message: 'thumbnail not found' });
      }
    }
    const filename = `${basename(file.path) || 'artifact'}-thumbnail`;
    return reply.redirect(await presignGet(thumbnail.s3Key, filename, true), 302);
  });
}
