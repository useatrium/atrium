import { posix as path } from 'node:path';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { DomainError } from './events.js';
import { appLaunchSignature } from './app-signing.js';

export type AppScope = 'channel' | 'workspace';

export interface PublishAppArgs {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  name: string;
  scope: AppScope;
  entry: string;
}

export interface PublishedApp {
  appId: string;
  version: number;
  files: number;
  entry: string;
}

export interface AppRegistryOptions {
  appsOrigin: string;
  signingSecret: string;
  launchTtlSeconds: number;
  storage?: {
    getObjectBytes(key: string): Promise<Buffer>;
  };
}

export interface AppListRow {
  id: string;
  workspaceId: string;
  channelId: string | null;
  name: string;
  scope: AppScope;
  status: string;
  currentVersion: number;
  entryPath: string;
  updatedAt: string;
}

export interface ResolvedAppFile {
  appId: string;
  version: number;
  relPath: string;
  blobSha: string;
  s3Key: string;
  mime: string;
  sizeBytes: number;
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class AppRegistry {
  constructor(
    private readonly pool: Db,
    private readonly options: AppRegistryOptions,
  ) {}

  async publish(args: PublishAppArgs): Promise<PublishedApp> {
    const name = normalizeAppName(args.name);
    const entry = normalizeAppRelPath(args.entry || 'index.html');
    const prefix = appSourcePrefix(args.scope, args.channelId, name);

    return withTx(this.pool, async (client) => {
      const frozen = await freezeSourceFiles(client, args.workspaceId, prefix);
      if (frozen.length === 0) {
        throw new DomainError(404, 'app_source_not_found', 'app source files not found');
      }
      for (const file of frozen) {
        if (file.kind === 'deleted') {
          throw new DomainError(409, 'app_source_deleted', `app source contains deleted file: ${file.rel_path}`);
        }
        if (!file.blob_sha || !file.s3_key) {
          throw new DomainError(503, 'blob_unavailable', `app source bytes are not durable: ${file.rel_path}`);
        }
      }
      const byPath = new Map(frozen.map((file) => [file.rel_path, file]));
      const entryFile = byPath.get(entry);
      if (!entryFile) {
        throw new DomainError(400, 'app_entry_missing', 'entry file is missing from app source');
      }
      await this.validateEntryAssets(entry, entryFile.s3_key!, byPath);

      const appRow = await findOrCreateApp(client, {
        workspaceId: args.workspaceId,
        channelId: args.scope === 'channel' ? args.channelId : null,
        name,
        scope: args.scope,
        entry,
        userId: args.userId,
      });
      const version = appRow.current_version + 1;
      for (const file of frozen) {
        await client.query(
          `INSERT INTO app_versions
             (app_id, version, rel_path, artifact_id, artifact_seq, blob_sha, mime, size_bytes, entry)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            appRow.id,
            version,
            file.rel_path,
            file.artifact_id,
            file.seq,
            file.blob_sha,
            file.mime,
            file.size_bytes,
            file.rel_path === entry,
          ],
        );
      }
      await client.query(
        `UPDATE apps
            SET current_version = $2, entry_path = $3, status = 'published', updated_at = now()
          WHERE id = $1`,
        [appRow.id, version, entry],
      );
      return { appId: appRow.id, version, files: frozen.length, entry };
    });
  }

  async listForUser(userId: string): Promise<AppListRow[]> {
    const res = await this.pool.query<{
      id: string;
      workspace_id: string;
      channel_id: string | null;
      name: string;
      scope: AppScope;
      status: string;
      current_version: number;
      entry_path: string;
      updated_at: Date | string;
    }>(
      `SELECT a.id, a.workspace_id, a.channel_id, a.name, a.scope, a.status,
              a.current_version, a.entry_path, a.updated_at
         FROM apps a
        WHERE EXISTS (
          SELECT 1 FROM workspace_members wm
           WHERE wm.workspace_id = a.workspace_id AND wm.user_id = $1
        )
          AND a.status = 'published'
        ORDER BY a.updated_at DESC, a.name ASC`,
      [userId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      name: row.name,
      scope: row.scope,
      status: row.status,
      currentVersion: row.current_version,
      entryPath: row.entry_path,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async launch(appId: string, userId: string, version?: number): Promise<{ url: string; expires: number; version: number }> {
    const app = await this.pool.query<{ current_version: number; entry_path: string; status: string }>(
      `SELECT current_version, entry_path, status
         FROM apps a
        WHERE a.id = $1
          AND EXISTS (
            SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id = a.workspace_id AND wm.user_id = $2
          )`,
      [appId, userId],
    );
    const row = app.rows[0];
    if (!row) throw new DomainError(404, 'app_not_found', 'app not found');
    if (row.status !== 'published' || row.current_version <= 0) {
      throw new DomainError(409, 'app_not_published', 'app is not published');
    }
    const launchVersion = version ?? row.current_version;
    if (!Number.isSafeInteger(launchVersion) || launchVersion <= 0 || launchVersion > row.current_version) {
      throw new DomainError(404, 'app_version_not_found', 'app version not found');
    }
    const entry = await this.resolveFile(appId, launchVersion, row.entry_path);
    if (!entry) throw new DomainError(404, 'app_entry_missing', 'entry file is missing');

    const expires = Math.floor(Date.now() / 1000) + this.options.launchTtlSeconds;
    const sig = appLaunchSignature({ appId, version: launchVersion, relPath: '*', expires }, this.options.signingSecret);
    const base = this.options.appsOrigin.replace(/\/+$/, '');
    const url = `${base}/apps/${appId}/v/${launchVersion}/g/${expires}/${encodeURIComponent(sig)}/${encodeRelPath(row.entry_path)}`;
    return { url, expires, version: launchVersion };
  }

  async resolveFile(appId: string, version: number, relPath: string): Promise<ResolvedAppFile | null> {
    const safePath = normalizeAppRelPath(relPath || 'index.html');
    const res = await this.pool.query<{
      blob_sha: string;
      s3_key: string | null;
      mime: string;
      size_bytes: string | number;
    }>(
      `SELECT av.blob_sha, b.s3_key, av.mime, av.size_bytes
         FROM apps a
         JOIN app_versions av ON av.app_id = a.id
         JOIN cas_blobs b ON b.sha256 = av.blob_sha
        WHERE a.id = $1
          AND av.version = $2
          AND av.rel_path = $3
          AND a.status = 'published'`,
      [appId, version, safePath],
    );
    const row = res.rows[0];
    if (!row?.s3_key) return null;
    return {
      appId,
      version,
      relPath: safePath,
      blobSha: row.blob_sha,
      s3Key: row.s3_key,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
    };
  }

  private async validateEntryAssets(
    entry: string,
    entryS3Key: string,
    files: Map<string, FrozenFile>,
  ): Promise<void> {
    const entryFile = files.get(entry);
    if (!entryFile) return;
    const mime = entryFile.mime.toLowerCase();
    if (!this.options.storage || (!mime.includes('html') && !entry.endsWith('.html'))) return;
    const html = (await this.options.storage.getObjectBytes(entryS3Key)).toString('utf8');
    const refs = extractObviousRelativeRefs(html);
    const baseDir = path.dirname(entry) === '.' ? '' : path.dirname(entry);
    for (const ref of refs) {
      const resolved = resolveRelativeAsset(baseDir, ref);
      if (!resolved || !files.has(resolved)) {
        throw new DomainError(400, 'app_asset_missing', `entry references missing asset: ${ref}`);
      }
    }
  }
}

interface FrozenFile {
  artifact_id: string;
  seq: number;
  rel_path: string;
  blob_sha: string | null;
  kind: string;
  mime: string;
  size_bytes: number;
  s3_key: string | null;
}

async function freezeSourceFiles(client: DbClient, workspaceId: string, prefix: string): Promise<FrozenFile[]> {
  const res = await client.query<{
    artifact_id: string;
    seq: number;
    rel_path: string;
    blob_sha: string | null;
    kind: string;
    mime: string | null;
    size_bytes: string | number | null;
    s3_key: string | null;
  }>(
    `SELECT a.id AS artifact_id, v.seq, substr(a.path, $3) AS rel_path,
            v.blob_sha, v.kind, b.mime, b.size_bytes, b.s3_key
       FROM artifacts a
       JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
       LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
      WHERE a.workspace_id = $1
        AND a.path LIKE $2
      ORDER BY a.path ASC`,
    [workspaceId, `${prefix}/%`, prefix.length + 2],
  );
  return res.rows.map((row) => ({
    artifact_id: row.artifact_id,
    seq: row.seq,
    rel_path: normalizeAppRelPath(row.rel_path),
    blob_sha: row.blob_sha,
    kind: row.kind,
    mime: row.mime ?? 'application/octet-stream',
    size_bytes: Number(row.size_bytes ?? 0),
    s3_key: row.s3_key,
  }));
}

async function findOrCreateApp(
  client: DbClient,
  args: {
    workspaceId: string;
    channelId: string | null;
    name: string;
    scope: AppScope;
    entry: string;
    userId: string;
  },
): Promise<{ id: string; current_version: number }> {
  const existing = await client.query<{ id: string; current_version: number }>(
    `SELECT id, current_version
       FROM apps
      WHERE workspace_id = $1
        AND name = $2
        AND scope = $3
        AND (($3 = 'workspace' AND channel_id IS NULL) OR channel_id = $4)
      FOR UPDATE`,
    [args.workspaceId, args.name, args.scope, args.channelId],
  );
  const row = existing.rows[0];
  if (row) {
    await client.query(
      `UPDATE apps
          SET status = 'published', entry_path = $2, updated_at = now()
        WHERE id = $1`,
      [row.id, args.entry],
    );
    return row;
  }
  const inserted = await client.query<{ id: string; current_version: number }>(
    `INSERT INTO apps (workspace_id, channel_id, name, scope, status, current_version, entry_path, created_by, updated_at)
     VALUES ($1, $2, $3, $4, 'published', 0, $5, $6, now())
     RETURNING id, current_version`,
    [args.workspaceId, args.channelId, args.name, args.scope, args.entry, args.userId],
  );
  return inserted.rows[0]!;
}

function appSourcePrefix(scope: AppScope, channelId: string, name: string): string {
  if (scope === 'workspace') return `shared/global/apps/${name}`;
  return `shared/channels/${channelId}/apps/${name}`;
}

function normalizeAppName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!APP_NAME_RE.test(name)) {
    throw new DomainError(400, 'bad_app_name', 'app name must be a safe slug');
  }
  return name;
}

export function normalizeAppRelPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new DomainError(400, 'bad_app_path', 'app path must be relative');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new DomainError(400, 'bad_app_path', 'app path must not contain dot segments');
  }
  return parts.join('/');
}

function extractObviousRelativeRefs(html: string): string[] {
  const refs = new Set<string>();
  const attrRe = /\b(?:src|href|action)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRe)) addRef(refs, match[1]);
  const urlRe = /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi;
  for (const match of html.matchAll(urlRe)) addRef(refs, match[1]);
  return [...refs];
}

function addRef(refs: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  const ref = raw.split('#', 1)[0]!.split('?', 1)[0]!.trim();
  if (!ref || ref.startsWith('#')) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return;
  refs.add(ref);
}

function resolveRelativeAsset(baseDir: string, ref: string): string | null {
  if (ref.startsWith('/')) return null;
  const joined = path.normalize(path.join(baseDir, ref));
  if (!joined || joined === '.' || joined.startsWith('../') || joined === '..') return null;
  try {
    return normalizeAppRelPath(joined);
  } catch {
    return null;
  }
}

function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}
