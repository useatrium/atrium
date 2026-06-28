import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { DomainError, type UserRef } from '../events.js';
import { ArtifactLedger, CHANGE_CURSOR_ZERO, type ChangeCursor } from '../artifact-ledger.js';
import { loadConflictDetail } from '../artifact-conflict.js';
import { artifactPathInRoots, classifyScope, type ArtifactScopeRoot } from '../artifact-scope.js';
import { displaySessionArtifactPath } from '../artifact-path.js';
import { canonicalizeRouteArtifactPath, firstHeader, normalizeMime } from '../artifact-route-utils.js';
import { writeBackArtifact, writeBackDelete } from '../artifact-writeback.js';
import { normalizeAppRelPath } from '../app-registry.js';
import { listLatestAppPresentations, refreshAppPresentations } from '../app-presentations.js';
import type { ArtifactServePlan, SessionRuns } from '../session-runs.js';
import { sanitizeFilename } from '../safe-filename.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';

type SessionArtifactAccess = {
  workspaceId: string;
  channelId: string;
  readableChannelIds: readonly string[];
  activePrefix: string;
  readableRoots: readonly ArtifactScopeRoot[];
  writableRoots: readonly ArtifactScopeRoot[];
};

export interface ArtifactRouteDeps {
  pool: Db;
  sessionRuns: SessionRuns;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
  sessionArtifactAccess(sessionId: string, userId?: string | null): Promise<SessionArtifactAccess>;
  serializeArtifactRoots(
    roots: readonly ArtifactScopeRoot[],
  ): Array<{ prefix: string; scope: string; writable: boolean }>;
}

async function previewBytes(plan: ArtifactServePlan): Promise<Buffer> {
  if (plan.kind === 'redirect') {
    if (plan.s3Key) {
      return getObjectBytes(plan.s3Key);
    }
    const response = await fetch(plan.url);
    if (!response.ok) {
      throw new DomainError(502, 'artifact_preview_fetch_failed', 'failed to fetch artifact preview bytes');
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new DomainError(500, 'artifact_preview_unsupported_plan', 'unsupported artifact preview serve plan');
}

function resolveArtifactPreviewRenderer(path: string, mime: string | null, hint?: string): 'html-app' | 'react-jsx' {
  const normalizedHint = (hint ?? '').trim().toLowerCase();
  if (normalizedHint === 'react-jsx') return 'react-jsx';
  if (normalizedHint === 'html-app') return 'html-app';
  if (/\.(jsx|tsx)$/i.test(path)) return 'react-jsx';
  if ((mime ?? '').toLowerCase() === 'text/html' || /\.html?$/i.test(path)) return 'html-app';
  return 'html-app';
}

function reactJsxPreviewDocument(source: string, filename: string): string {
  const sourceJson = JSON.stringify(source);
  const titleJson = JSON.stringify(filename);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(filename)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <pre id="artifact-error" style="display:none; white-space:pre-wrap; padding:16px; color:#991b1b;"></pre>
  <script>
    const source = ${sourceJson};
    const title = ${titleJson};
    function showError(error) {
      const el = document.getElementById('artifact-error');
      el.style.display = 'block';
      el.textContent = String(error && error.stack ? error.stack : error);
    }
    function toRunnableJsx(input) {
      return input
        .replace(/^\\s*import\\s+.*?from\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/^\\s*import\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/export\\s+default\\s+function\\s+([A-Za-z0-9_$]+)/, 'function $1')
        .replace(/export\\s+default\\s+/, 'const App = ');
    }
    try {
      const cleaned = toRunnableJsx(source);
      // Force the classic JSX runtime: @babel/standalone now defaults the react
      // preset to the automatic runtime, which injects \`import { jsx } from
      // "react/jsx-runtime"\` — an import statement that throws inside new Function.
      // Classic emits React.createElement, which the scaffold supplies React for.
      const transformed = Babel.transform(cleaned, { presets: [['react', { runtime: 'classic' }]] }).code;
      const factory = new Function('React', transformed + '\\n; return typeof App !== "undefined" ? App : (typeof exports !== "undefined" && exports.default) || null;');
      const App = factory(React);
      if (!App) throw new Error('No default React component found in ' + title);
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    } catch (error) {
      showError(error);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

export async function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): Promise<void> {
  const { pool, sessionRuns, requireSessionAccess, sessionArtifactAccess, serializeArtifactRoots } = deps;

  app.get('/api/sessions/:id/artifacts/by-path', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; at?: string };
    const rawPath = q.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const path = canonicalizeRouteArtifactPath(reply, rawPath, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    const scope = classifyScope(path);
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const displayPath = displaySessionArtifactPath(path, { sessionId: id, channelId });
    const at = q.at ?? 'latest';
    let ref: { seq: number } | { pointer: string };
    const ledger = new ArtifactLedger(pool);
    if (at === 'latest') {
      const res = await ledger.serveResolution(id, path, { readableChannelIds: access.readableChannelIds });
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      reply.header('X-Artifact-Seq', String(res.servedSeq));
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      ref = { seq: res.servedSeq };
    } else {
      ref = /^\d+$/.test(at) ? { seq: Number(at) } : { pointer: at };
    }
    const plan = await sessionRuns.getLedgerServePlan(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const version = await ledger.resolveVersion(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    reply.header('X-Artifact-Scope', scope);
    reply.header('X-Artifact-Canonical-Path', path);
    reply.header('X-Artifact-Display-Path', displayPath);
    if (version) {
      if (version.blobSha != null) reply.header('X-Artifact-Sha', version.blobSha);
      reply.header('X-Size-Bytes', String(version.sizeBytes ?? 0));
      reply.header('X-Detected-Mime', version.detectedMime ?? version.mime ?? 'application/octet-stream');
      reply.header('X-Media-Kind', version.mediaKind ?? 'binary');
      reply.header('X-Is-Text', version.isText ? 'true' : 'false');
      if (version.textEncoding != null) reply.header('X-Text-Encoding', version.textEncoding);
    }
    return reply.redirect(plan.url, 302);
  });

  app.get('/api/sessions/:id/artifacts/presentations', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const access = await sessionArtifactAccess(id, user.id);
    await refreshAppPresentations(pool, { sessionId: id, getObjectBytes }).catch((err) => {
      req.log.warn({ err, sessionId: id }, 'failed to refresh app presentations');
    });
    const persisted = await listLatestAppPresentations(pool, id);
    if (persisted.length > 0) {
      const presentations = persisted
        .map((row) => {
          const path = `shared/apps/${row.app_slug}/${row.entry_path}`;
          if (!artifactPathInRoots(path, access.readableRoots)) return null;
          return {
            id: `artifact-presented:${path}`,
            presentationId: row.id,
            version: row.version,
            appSlug: row.app_slug,
            path,
            title: row.title,
            renderer: row.renderer,
            description: row.description,
            previewUrl: row.preview_url,
            previewSizePolicy: row.preview_size_policy,
            statePolicy: row.state_policy,
            executionId: null,
            sourceEventIds: jsonNumberArray(row.source_event_ids),
          };
        })
        .filter((presentation): presentation is NonNullable<typeof presentation> => presentation !== null)
        .sort((a, b) => a.path.localeCompare(b.path));
      return reply.send({ presentations });
    }
    const res = await pool.query<{ path: string; s3_key: string | null }>(
      `SELECT a.path, b.s3_key
         FROM artifacts a
         JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
         JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
         LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
        WHERE a.workspace_id = $1
          AND a.session_id = $2
          AND a.path LIKE 'shared/apps/%/%'
          AND v.kind <> 'deleted'
        ORDER BY a.path ASC`,
      [access.workspaceId, id],
    );
    const dirs = new Map<string, Map<string, string | null>>();
    for (const row of res.rows) {
      const m = /^shared\/apps\/([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/.exec(row.path);
      if (!m) continue;
      const slug = m[1]!;
      if (!dirs.has(slug)) dirs.set(slug, new Map());
      dirs.get(slug)!.set(m[2]!, row.s3_key);
    }
    const presentations: Array<{
      id: string;
      path: string;
      title: string | null;
      renderer: string;
      description: string | null;
      executionId: string | null;
      sourceEventIds: number[];
    }> = [];
    for (const [slug, files] of dirs) {
      let manifest: Record<string, unknown> = {};
      const manifestKey = files.get('atrium.app.json');
      if (manifestKey) {
        try {
          const parsed = JSON.parse((await getObjectBytes(manifestKey)).toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            manifest = parsed as Record<string, unknown>;
          }
        } catch {
          /* ignore malformed manifest; default metadata below */
        }
      }
      let entry: string;
      try {
        entry = normalizeAppRelPath(
          typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : 'index.html',
        );
      } catch {
        entry = 'index.html';
      }
      if (!files.has(entry)) continue;
      const path = `shared/apps/${slug}/${entry}`;
      if (!artifactPathInRoots(path, access.readableRoots)) continue;
      const renderer =
        typeof manifest.renderer === 'string' && manifest.renderer.trim()
          ? manifest.renderer
          : /\.(jsx|tsx)$/i.test(entry)
            ? 'react-jsx'
            : 'html-app';
      presentations.push({
        id: `artifact-presented:${path}`,
        path,
        title:
          typeof manifest.title === 'string' && manifest.title.trim()
            ? manifest.title
            : typeof manifest.name === 'string' && manifest.name.trim()
              ? manifest.name
              : slug,
        renderer,
        description: typeof manifest.description === 'string' ? manifest.description : null,
        executionId: null,
        sourceEventIds: [],
      });
    }
    presentations.sort((a, b) => a.path.localeCompare(b.path));
    return reply.send({ presentations });
  });

  app.get('/api/sessions/:id/artifacts/preview', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; at?: string; renderer?: string };
    const rawPath = q.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const sharedChannelId = rawPath
      .trim()
      .replace(/\\/g, '/')
      .match(/^shared\/channels\/([^/]+)\//)?.[1];
    if (sharedChannelId && sharedChannelId !== channelId && !access.readableChannelIds.includes(sharedChannelId)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const path = canonicalizeRouteArtifactPath(reply, rawPath, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    const scope = classifyScope(path);
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const displayPath = displaySessionArtifactPath(path, { sessionId: id, channelId });
    const at = q.at ?? 'latest';
    let ref: { seq: number } | { pointer: string };
    const ledger = new ArtifactLedger(pool);
    if (at === 'latest') {
      const res = await ledger.serveResolution(id, path, { readableChannelIds: access.readableChannelIds });
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      reply.header('X-Artifact-Seq', String(res.servedSeq));
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      ref = { seq: res.servedSeq };
    } else {
      ref = /^\d+$/.test(at) ? { seq: Number(at) } : { pointer: at };
    }
    const plan = await sessionRuns.getLedgerServePlan(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const version = await ledger.resolveVersion(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const bytes = await previewBytes(plan);
    const renderer = resolveArtifactPreviewRenderer(path, version?.mime ?? null, q.renderer);
    const filename = basename(path) || 'artifact';
    reply.header('X-Artifact-Scope', scope);
    reply.header('X-Artifact-Canonical-Path', path);
    reply.header('X-Artifact-Display-Path', displayPath);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', `inline; filename="${sanitizeFilename(filename)}"`);
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://esm.sh https://cdn.tailwindcss.com",
        "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
        'img-src data: blob: https:',
        'font-src data: https:',
        'connect-src https:',
        "frame-ancestors 'self'",
      ].join('; '),
    );
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (renderer === 'react-jsx') {
      return reply.send(reactJsxPreviewDocument(bytes.toString('utf8'), filename));
    }
    return reply.send(bytes);
  });

  app.get('/api/sessions/:id/artifacts/changes', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };

    let cursor: ChangeCursor = CHANGE_CURSOR_ZERO;
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

    const ledger = new ArtifactLedger(pool);
    const page = await ledger.changesSince(id, cursor, limit);
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const rows = page.rows
      .map((row) => ({
        ...row,
        canonicalPath: row.path,
        displayPath: displaySessionArtifactPath(row.path, { sessionId: id, channelId }),
        scope: classifyScope(row.path),
      }))
      .filter((row) => artifactPathInRoots(row.path, access.readableRoots));
    return reply.send({
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });

  app.get('/api/sessions/:id/artifacts/conflict', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const path = (req.query as { path?: string }).path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!canonicalPath) return;
    if (!artifactPathInRoots(canonicalPath, access.readableRoots)) {
      return reply.code(404).send({ error: 'no_conflict', message: 'no unresolved conflict at path' });
    }
    const detail = await loadConflictDetail(pool, { getObjectBytes }, id, canonicalPath, {
      readableChannelIds: access.readableChannelIds,
    });
    if (!detail) {
      return reply.code(404).send({ error: 'no_conflict', message: 'no unresolved conflict at path' });
    }
    return reply.send({
      ...detail,
      canonicalPath: detail.path,
      displayPath: displaySessionArtifactPath(detail.path, { sessionId: id, channelId }),
    });
  });

  app.register(async (resolveScope) => {
    resolveScope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
    );
    resolveScope.post('/api/sessions/:id/artifacts/:artifactId/resolve', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id, artifactId } = req.params as { id: string; artifactId: string };
      const ledger = new ArtifactLedger(pool);
      const art = await ledger.artifactById(artifactId);
      if (!art) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      const access = await sessionArtifactAccess(id, user.id);
      if (art.workspaceId !== access.workspaceId || !artifactPathInRoots(art.path, access.writableRoots)) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      const conflict = await ledger.getConflict(id, art.path, { readableChannelIds: access.readableChannelIds });
      if (!conflict) {
        return reply.code(409).send({ error: 'no_conflict', message: 'artifact has no unresolved conflict' });
      }
      const stayDeleted = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const result = stayDeleted
        ? await writeBackDelete({
            pool,
            channelId: access.channelId,
            sessionId: id,
            path: art.path,
            author: `human:${user.id}`,
            baseSeq: conflict.conflictSeq,
          })
        : await writeBackArtifact({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            channelId: access.channelId,
            sessionId: id,
            path: art.path,
            bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            mime: normalizeMime(firstHeader(req.headers['content-type'])),
            author: `human:${user.id}`,
            baseSeq: conflict.conflictSeq,
          });
      if (!result.ok) {
        return reply.code(409).send({ error: result.reason });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });

  app.get('/api/sessions/:id/hydration-scope', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const ledger = new ArtifactLedger(pool);
    const paths = await ledger.sessionScope(id);
    const scopedPaths = paths
      .map((path) => ({
        ...path,
        canonicalPath: path.path,
        displayPath: displaySessionArtifactPath(path.path, { sessionId: id, channelId }),
        scope: classifyScope(path.path),
      }))
      .filter((path) => artifactPathInRoots(path.path, access.readableRoots));
    return reply.send({
      sessionId: id,
      scope: 'session',
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      paths: scopedPaths,
    });
  });
}
