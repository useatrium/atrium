import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { ArtifactLedger } from '../artifact-ledger.js';
import {
  artifactPathInRoots,
  classifyScope,
  userCanReadSessionArtifactPath,
  type ArtifactScope,
  type ArtifactScopeRoot,
} from '../artifact-scope.js';
import { displaySessionArtifactPath, sessionArtifactPathAliases } from '../artifact-path.js';
import {
  canonicalizeRouteArtifactPath,
  firstHeader,
  mediaHeaders,
  normalizeMime,
  parseBaseSeq,
} from '../artifact-route-utils.js';
import { writeBackArtifact } from '../artifact-writeback.js';
import { classifyMedia, type MediaClassification } from '../media-classifier.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';

type SessionArtifactAccess = {
  workspaceId: string;
  channelId: string;
  readableChannelIds: readonly string[];
  activePrefix: string;
  readableRoots: readonly ArtifactScopeRoot[];
  writableRoots: readonly ArtifactScopeRoot[];
};

export interface FileRouteDeps {
  pool: Db;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
  sessionArtifactAccess(sessionId: string, userId?: string | null): Promise<SessionArtifactAccess>;
  serializeArtifactRoots(
    roots: readonly ArtifactScopeRoot[],
  ): Array<{ prefix: string; scope: string; writable: boolean }>;
}

type UnifiedFileRow = {
  path: string;
  canonicalPath?: string;
  displayPath?: string;
  backing: 'git' | 'ledger';
  type: 'file' | 'dir';
  scope?: ArtifactScope;
  mime?: string;
  mediaKind?: string;
  isText?: boolean;
  sizeBytes?: number;
  seq?: number;
};

export async function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): Promise<void> {
  const { createGitSource } = await import('../git-source.js');
  const { resolveBacking } = await import('../file-resolver.js');
  const gitPrefix = normalizeFilesGitPrefix(process.env.GIT_PREFIX ?? 'repo/');
  const gitSource = createGitSource(process.env.GIT_REPO_ROOT);
  const { pool, requireSessionAccess, sessionArtifactAccess, serializeArtifactRoots } = deps;

  function normalizeFilesGitPrefix(value: string): string {
    const trimmed = value.trim();
    const prefix = trimmed.length > 0 ? trimmed : 'repo/';
    return prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  function normalizeFilesDir(value: unknown): string | null {
    if (value == null) return '';
    if (typeof value !== 'string') return null;
    const dir = value.trim();
    if (dir.includes('\0') || dir.includes('..') || dir.startsWith('/')) return null;
    return dir.replace(/\/+$/g, '');
  }

  function normalizeFilesPath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const path = value.trim();
    if (!path || path.includes('\0') || path.includes('..') || path.startsWith('/')) return null;
    return path;
  }

  function gitRelDirForApiDir(dir: string): string | null {
    const prefixRoot = gitPrefix.replace(/\/+$/g, '');
    if (dir.length === 0) return '';
    if (dir === prefixRoot) return '';
    if (dir.startsWith(gitPrefix)) return dir.slice(gitPrefix.length).replace(/\/+$/g, '');
    return null;
  }

  function ledgerRowsForDir(
    scope: Array<{
      path: string;
      latestSeq: number;
      kind: string;
      detectedMime: string | null;
      mediaKind: string | null;
      isText: boolean | null;
      sizeBytes: number | null;
    }>,
    dir: string,
    ctx: { sessionId: string; channelId: string },
  ): UnifiedFileRow[] {
    const prefix = dir.length > 0 ? `${dir}/` : '';
    const rows = new Map<string, UnifiedFileRow>();
    for (const item of scope) {
      const artifactScope = classifyScope(item.path);
      if (!userCanReadSessionArtifactPath(item.path, ctx.sessionId)) continue;
      if (item.kind === 'deleted') continue;
      if (resolveBacking(item.path, { gitPrefix }).backing !== 'ledger') continue;
      for (const alias of sessionArtifactPathAliases(item.path, ctx)) {
        if (!alias.startsWith(prefix)) continue;
        const rest = alias.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        const path = slash < 0 ? alias : `${prefix}${rest.slice(0, slash)}`;
        const type = slash < 0 ? 'file' : 'dir';
        const rowScope = artifactScope;
        const canonicalPath = type === 'file' ? item.path : undefined;
        const displayPath = type === 'file' ? displaySessionArtifactPath(item.path, ctx) : undefined;
        if (!rows.has(path) || type === 'dir') {
          rows.set(path, {
            path,
            canonicalPath,
            displayPath,
            backing: 'ledger',
            type,
            scope: rowScope,
            ...(type === 'file' && item.detectedMime != null ? { mime: item.detectedMime } : {}),
            ...(type === 'file' && item.mediaKind != null ? { mediaKind: item.mediaKind } : {}),
            ...(type === 'file' && item.isText != null ? { isText: item.isText } : {}),
            ...(type === 'file' && item.sizeBytes != null ? { sizeBytes: Number(item.sizeBytes) } : {}),
            ...(type === 'file' ? { seq: item.latestSeq } : {}),
          });
        }
      }
    }
    return [...rows.values()];
  }

  function bodyBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    return Buffer.alloc(0);
  }

  function unsafeGitPathError(err: unknown): boolean {
    return err instanceof Error && err.message === 'unsafe git path';
  }

  function isoDate(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  async function ledgerHistory(sessionId: string, path: string) {
    const res = await pool.query<{
      seq: number;
      blob_sha: string | null;
      author: string;
      kind: string;
      status: string;
      created_at: Date | string;
    }>(
      `SELECT v.seq, v.blob_sha, v.author, v.kind, v.status, v.created_at
         FROM sessions s
         JOIN artifacts a ON a.workspace_id = s.workspace_id
         JOIN artifact_versions v ON v.artifact_id = a.id
        WHERE s.id = $1 AND a.path = $2
        ORDER BY v.seq DESC`,
      [sessionId, path],
    );
    return res.rows.map((row) => ({
      seq: row.seq,
      sha: row.blob_sha,
      author: row.author,
      date: isoDate(row.created_at),
      kind: row.kind,
      status: row.status,
    }));
  }

  await app.register(async (filesScope) => {
    filesScope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );

    filesScope.get('/api/sessions/:id/files', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id } = req.params as { id: string };
      const dir = normalizeFilesDir((req.query as { dir?: unknown }).dir);
      if (dir == null) {
        return reply.code(400).send({ error: 'bad_query', message: 'dir must be a safe relative path' });
      }

      const access = await sessionArtifactAccess(id, user.id);
      const channelId = access.channelId;
      const ledger = new ArtifactLedger(pool);
      const rows = ledgerRowsForDir(await ledger.sessionScope(id), dir, { sessionId: id, channelId });
      const gitRelDir = gitRelDirForApiDir(dir);
      if (gitRelDir != null && gitSource.isConfigured()) {
        try {
          const gitRows = await gitSource.listDir(gitRelDir);
          rows.push(...gitRows.map((row) => ({ ...row, path: `${gitPrefix}${row.path}`, backing: 'git' as const })));
        } catch (err) {
          if (unsafeGitPathError(err)) {
            return reply.code(400).send({ error: 'bad_query', message: 'dir must be a safe relative path' });
          }
          throw err;
        }
      }
      rows.sort((a, b) => a.path.localeCompare(b.path) || a.backing.localeCompare(b.backing));
      return reply.send({
        activePrefix: access.activePrefix,
        readableRoots: serializeArtifactRoots(access.readableRoots),
        writableRoots: serializeArtifactRoots(access.writableRoots),
        rows,
      });
    });

    filesScope.get('/api/sessions/:id/files/history', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id } = req.params as { id: string };
      const path = normalizeFilesPath((req.query as { path?: unknown }).path);
      if (path == null) {
        return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
      }

      const resolved = resolveBacking(path, { gitPrefix });
      const access = resolved.backing === 'ledger' ? await sessionArtifactAccess(id, user.id) : null;
      const channelId = access?.channelId ?? null;
      const ledgerPath =
        resolved.backing === 'ledger'
          ? canonicalizeRouteArtifactPath(reply, resolved.relPath, {
              sessionId: id,
              channelId: channelId!,
              readableChannelIds: access!.readableChannelIds,
            })
          : resolved.relPath;
      if (!ledgerPath) return;
      const scope = classifyScope(ledgerPath);
      if (resolved.backing === 'ledger' && !artifactPathInRoots(ledgerPath, access!.readableRoots)) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      if (resolved.backing === 'git') {
        if (!gitSource.isConfigured()) {
          return reply.code(404).send({ error: 'git_source_unconfigured', message: 'git source not configured' });
        }
        try {
          return reply.send({ backing: 'git', entries: await gitSource.history(resolved.relPath) });
        } catch (err) {
          if (unsafeGitPathError(err)) {
            return reply.code(400).send({ error: 'bad_query', message: 'path must be a safe relative path' });
          }
          throw err;
        }
      }

      return reply.send({
        backing: 'ledger',
        scope,
        canonicalPath: ledgerPath,
        displayPath: displaySessionArtifactPath(ledgerPath, { sessionId: id, channelId: channelId! }),
        entries: await ledgerHistory(id, ledgerPath),
      });
    });

    filesScope.get('/api/sessions/:id/files/content', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id } = req.params as { id: string };
      const path = normalizeFilesPath((req.query as { path?: unknown }).path);
      if (path == null) {
        return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
      }
      const resolved = resolveBacking(path, { gitPrefix });
      let ledgerPath = resolved.relPath;
      let ledgerChannelId: string | null = null;
      let ledgerAccess: SessionArtifactAccess | null = null;
      if (resolved.backing === 'ledger') {
        ledgerAccess = await sessionArtifactAccess(id, user.id);
        const channelId = ledgerAccess.channelId;
        ledgerChannelId = channelId;
        const canonicalPath = canonicalizeRouteArtifactPath(reply, resolved.relPath, {
          sessionId: id,
          channelId,
          readableChannelIds: ledgerAccess.readableChannelIds,
        });
        if (!canonicalPath) return;
        ledgerPath = canonicalPath;
        if (!artifactPathInRoots(ledgerPath, ledgerAccess.readableRoots)) {
          return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
        }
      }
      if (resolved.backing === 'git') {
        if (!gitSource.isConfigured()) {
          return reply.code(404).send({ error: 'git_source_unconfigured', message: 'git source not configured' });
        }
        try {
          const file = await gitSource.readFile(resolved.relPath);
          if (!file) return reply.code(404).send({ error: 'not_found', message: 'file not found' });
          const classification = classifyMedia(file.bytes, { filename: resolved.relPath });
          reply.header('X-File-Backing', 'git');
          reply.header('X-Git-Blob-Sha', file.sha);
          reply.header('X-Canonical-Path', resolved.relPath);
          reply.header('X-Display-Path', path);
          reply.header('X-Size-Bytes', String(file.bytes.byteLength));
          for (const [name, value] of Object.entries(mediaHeaders(classification))) reply.header(name, value);
          reply.header(
            'Content-Type',
            classification.isText
              ? `${classification.detectedMime}; charset=${classification.textEncoding ?? 'utf-8'}`
              : classification.detectedMime,
          );
          return reply.send(file.bytes);
        } catch (err) {
          if (unsafeGitPathError(err)) {
            return reply.code(400).send({ error: 'bad_query', message: 'path must be a safe relative path' });
          }
          throw err;
        }
      }
      const ledger = new ArtifactLedger(pool);
      const res = await ledger.serveResolution(id, ledgerPath, {
        readableChannelIds: ledgerAccess?.readableChannelIds,
      });
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      const version = await ledger.resolveVersion(
        id,
        ledgerPath,
        { seq: res.servedSeq },
        {
          readableChannelIds: ledgerAccess?.readableChannelIds,
        },
      );
      if (!version) return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      if (version.kind === 'deleted') {
        return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
      }
      if (!version.s3Key || !version.blobSha) {
        return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
      }
      const bytes = await getObjectBytes(version.s3Key);
      const classification = {
        detectedMime: version.detectedMime ?? version.mime ?? 'application/octet-stream',
        mediaKind: version.mediaKind ?? 'binary',
        isText: version.isText ?? false,
        textEncoding: version.textEncoding ?? null,
        meta: {},
      } satisfies MediaClassification;
      reply.header('X-File-Backing', 'ledger');
      reply.header('X-Artifact-Seq', String(version.seq));
      reply.header('X-Artifact-Sha', version.blobSha);
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      reply.header('X-Canonical-Path', ledgerPath);
      reply.header(
        'X-Display-Path',
        displaySessionArtifactPath(ledgerPath, { sessionId: id, channelId: ledgerChannelId! }),
      );
      reply.header('X-Size-Bytes', String(version.sizeBytes ?? bytes.byteLength));
      for (const [name, value] of Object.entries(mediaHeaders(classification))) reply.header(name, value);
      reply.header(
        'Content-Type',
        classification.isText
          ? `${classification.detectedMime}; charset=${classification.textEncoding ?? 'utf-8'}`
          : classification.detectedMime,
      );
      return reply.send(bytes);
    });

    filesScope.put('/api/sessions/:id/files', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id } = req.params as { id: string };
      const path = normalizeFilesPath((req.query as { path?: unknown }).path);
      if (path == null) {
        return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
      }

      const resolved = resolveBacking(path, { gitPrefix });
      if (resolved.backing === 'git') {
        return reply.code(405).send({
          error: 'repo_read_only',
          message: 'repo files are read-only in-app; steer the agent to change code',
        });
      }

      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }
      const access = await sessionArtifactAccess(id, user.id);
      const channelId = access.channelId;
      const canonicalPath = canonicalizeRouteArtifactPath(reply, resolved.relPath, {
        sessionId: id,
        channelId,
        readableChannelIds: access.readableChannelIds,
      });
      if (!canonicalPath) return;
      if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
        return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
      }
      const body = bodyBuffer(req.body);
      const classification = classifyMedia(body, {
        declaredMime: normalizeMime(firstHeader(req.headers['content-type'])),
        filename: canonicalPath,
      });
      if (!classification.isText) {
        return reply.code(415).send({
          error: 'binary_not_editable',
          message: 'binary files cannot be edited as text',
          mediaKind: classification.mediaKind,
        });
      }
      const result = await writeBackArtifact({
        pool,
        storage: { uploadObject, getObjectBytes, headObject },
        channelId,
        sessionId: id,
        path: canonicalPath,
        bytes: body,
        mime: classification.detectedMime,
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
      return reply.send({ backing: 'ledger', seq: result.seq });
    });
  });
}
