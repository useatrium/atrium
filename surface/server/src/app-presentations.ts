import type { Db } from './db.js';
import { normalizeAppRelPath } from './app-registry.js';

const APP_PATH_RE = /^shared\/apps\/([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/;

export interface AppPresentationRow {
  id: string;
  app_slug: string;
  version: number;
  title: string | null;
  description: string | null;
  renderer: string;
  entry_path: string;
  preview_url: string | null;
  preview_size_policy: unknown;
  state_policy: unknown;
  source_event_ids: unknown;
}

interface SourceFile {
  artifact_id: string;
  artifact_seq: number;
  path: string;
  rel_path: string;
  blob_sha: string | null;
  s3_key: string | null;
}

interface ParsedManifest {
  title: string | null;
  description: string | null;
  renderer: string;
  entryPath: string;
  previewEnabled: boolean;
  previewUrl: string | null;
  previewSizePolicy: Record<string, unknown>;
  statePolicy: Record<string, unknown>;
}

export async function refreshAppPresentations(
  pool: Db,
  args: {
    sessionId: string;
    getObjectBytes: (key: string) => Promise<Buffer>;
  },
): Promise<void> {
  const session = await pool.query<{ workspace_id: string; channel_id: string }>(
    'SELECT workspace_id, channel_id FROM sessions WHERE id = $1',
    [args.sessionId],
  );
  const sessionRow = session.rows[0];
  if (!sessionRow) return;

  const files = await pool.query<SourceFile>(
    `SELECT a.id AS artifact_id, v.seq AS artifact_seq, a.path,
            substring(a.path from '^shared/apps/[a-z0-9][a-z0-9_-]{0,63}/(.+)$') AS rel_path,
            v.blob_sha, b.s3_key
       FROM artifacts a
       JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
       LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
      WHERE a.workspace_id = $1
        AND a.session_id = $2
        AND a.path LIKE 'shared/apps/%/%'
        AND v.kind <> 'deleted'
      ORDER BY a.path ASC`,
    [sessionRow.workspace_id, args.sessionId],
  );

  const dirs = new Map<string, Map<string, SourceFile>>();
  for (const file of files.rows) {
    const match = APP_PATH_RE.exec(file.path);
    if (!match) continue;
    const slug = match[1]!;
    const relPath = match[2]!;
    if (!dirs.has(slug)) dirs.set(slug, new Map());
    dirs.get(slug)!.set(relPath, { ...file, rel_path: relPath });
  }

  const activeSlugs = new Set<string>();
  for (const [slug, appFiles] of dirs) {
    const manifestFile = appFiles.get('atrium.app.json') ?? null;
    const manifest = await parseManifest(manifestFile?.s3_key ?? null, args.getObjectBytes);
    const entryFile = appFiles.get(manifest.entryPath);
    if (!entryFile?.blob_sha) continue;
    activeSlugs.add(slug);

    const previewUrl = effectivePreviewUrl(manifest, appFiles);
    const previewSizePolicy = {
      ...manifest.previewSizePolicy,
      enabled: manifest.previewEnabled,
      url: previewUrl,
    };

    const last = await pool.query<{
      version: number;
      entry_path: string;
      entry_blob_sha: string;
      manifest_blob_sha: string | null;
      status: string;
    }>(
      `SELECT version, entry_path, entry_blob_sha, manifest_blob_sha, status
         FROM app_presentations
        WHERE session_id = $1 AND app_slug = $2
        ORDER BY version DESC
        LIMIT 1`,
      [args.sessionId, slug],
    );
    const lastRow = last.rows[0];
    if (
      lastRow &&
      lastRow.entry_path === manifest.entryPath &&
      lastRow.entry_blob_sha === entryFile.blob_sha &&
      (lastRow.manifest_blob_sha ?? null) === (manifestFile?.blob_sha ?? null)
    ) {
      if (lastRow.status !== 'active') {
        await pool.query(
          `UPDATE app_presentations
              SET status = 'active', updated_at = now()
            WHERE session_id = $1 AND app_slug = $2 AND version = $3`,
          [args.sessionId, slug, lastRow.version],
        );
      }
      continue;
    }

    const nextVersion = (lastRow?.version ?? 0) + 1;
    await pool.query(
      `INSERT INTO app_presentations (
         workspace_id, channel_id, session_id, app_slug, version,
         title, description, renderer, entry_path, preview_url,
         preview_size_policy, state_policy,
         manifest_artifact_id, manifest_artifact_seq, manifest_blob_sha,
         entry_artifact_id, entry_artifact_seq, entry_blob_sha,
         source_event_ids
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11::jsonb, $12::jsonb,
         $13, $14, $15,
         $16, $17, $18,
         '[]'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [
        sessionRow.workspace_id,
        sessionRow.channel_id,
        args.sessionId,
        slug,
        nextVersion,
        manifest.title ?? slug,
        manifest.description,
        manifest.renderer,
        manifest.entryPath,
        previewUrl,
        JSON.stringify(previewSizePolicy),
        JSON.stringify(manifest.statePolicy),
        manifestFile?.artifact_id ?? null,
        manifestFile?.artifact_seq ?? null,
        manifestFile?.blob_sha ?? null,
        entryFile.artifact_id,
        entryFile.artifact_seq,
        entryFile.blob_sha,
      ],
    );
  }

  await deactivateMissingPresentations(pool, args.sessionId, [...activeSlugs]);
}

export async function listLatestAppPresentations(pool: Db, sessionId: string): Promise<AppPresentationRow[]> {
  const res = await pool.query<AppPresentationRow>(
    `SELECT DISTINCT ON (session_id, app_slug)
            id, app_slug, version, title, description, renderer, entry_path,
            preview_url, preview_size_policy, state_policy, source_event_ids
       FROM app_presentations
      WHERE session_id = $1
        AND status = 'active'
      ORDER BY session_id, app_slug, version DESC`,
    [sessionId],
  );
  return res.rows;
}

async function deactivateMissingPresentations(pool: Db, sessionId: string, activeSlugs: string[]): Promise<void> {
  await pool.query(
    `UPDATE app_presentations
        SET status = 'inactive', updated_at = now()
      WHERE session_id = $1
        AND status = 'active'
        AND NOT (app_slug = ANY($2::text[]))`,
    [sessionId, activeSlugs],
  );
}

async function parseManifest(
  s3Key: string | null,
  getObjectBytes: (key: string) => Promise<Buffer>,
): Promise<ParsedManifest> {
  let raw: Record<string, unknown> = {};
  if (s3Key) {
    try {
      const parsed = JSON.parse((await getObjectBytes(s3Key)).toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
  }

  const entryRaw = stringField(raw, 'entrypoint') ?? stringField(raw, 'entry') ?? 'index.html';
  let entryPath: string;
  try {
    entryPath = normalizeAppRelPath(entryRaw);
  } catch {
    entryPath = 'index.html';
  }

  const preview = objectField(raw, 'preview');
  const previewEnabled = preview ? preview.enabled !== false : true;
  const previewUrl = previewEnabled
    ? normalizePreviewUrl(stringField(preview ?? {}, 'url') ?? `${entryPath}?preview=1`, entryPath)
    : null;

  return {
    title: stringField(raw, 'title') ?? stringField(raw, 'name'),
    description: stringField(raw, 'description'),
    renderer: stringField(raw, 'renderer') ?? (/\.(jsx|tsx)$/i.test(entryPath) ? 'react-jsx' : 'html-app'),
    entryPath,
    previewEnabled,
    previewUrl,
    previewSizePolicy: {
      defaultSize: stringField(preview ?? {}, 'defaultSize') ?? 'card',
      sizes: Array.isArray(preview?.sizes) ? preview.sizes : [],
    },
    statePolicy: objectField(raw, 'state') ?? { mode: 'isolated' },
  };
}

function effectivePreviewUrl(manifest: ParsedManifest, files: Map<string, SourceFile>): string | null {
  if (!manifest.previewEnabled) return null;
  const previewUrl = manifest.previewUrl ?? `${manifest.entryPath}?preview=1`;
  const previewPath = previewPathPart(previewUrl) ?? manifest.entryPath;
  return files.has(previewPath) ? previewUrl : `${manifest.entryPath}?preview=1`;
}

function previewPathPart(previewUrl: string): string | null {
  const [pathPart] = previewUrl.split(/[?#]/, 1);
  if (!pathPart) return null;
  try {
    return normalizeAppRelPath(pathPart);
  } catch {
    return null;
  }
}

function normalizePreviewUrl(value: string, entryPath: string): string {
  const trimmed = value.trim();
  if (!trimmed) return `${entryPath}?preview=1`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return `${entryPath}?preview=1`;
  const [pathPart, suffix = ''] = trimmed.split(/([?#].*)/, 2);
  try {
    const relPath = normalizeAppRelPath(pathPart || entryPath);
    return `${relPath}${suffix}`;
  } catch {
    return `${entryPath}?preview=1`;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
