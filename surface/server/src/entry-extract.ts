import { createHash } from 'node:crypto';
import { ArtifactLedger, casBlobKey } from './artifact-ledger.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { decodeHandle, type NormalizedEntry } from './entries.js';
import { classifyMediaFromMime } from './media-classifier.js';
import { uploadObject } from './s3.js';

const MARKDOWN_MIME = 'text/markdown';
const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface ExtractedEntryArtifact {
  artifactId: string;
  path: string;
  seq: number;
  workspaceId: string;
  created: boolean;
}

interface EntryScope {
  workspaceId: string;
  channelId: string;
  sessionId?: string;
  sourceMessageId?: string | null;
}

export async function extractEntryToMarkdownArtifact(
  pool: Db,
  params: { handle: string; entry: NormalizedEntry; userId: string },
): Promise<ExtractedEntryArtifact> {
  if (params.entry.text.trim().length === 0) {
    const err = new Error('entry text is empty') as Error & { statusCode: number; code: string };
    err.statusCode = 422;
    err.code = 'empty_entry_text';
    throw err;
  }

  const scope = await resolveExtractScope(pool, params.handle);
  const title = deriveTitle(params.entry.text);
  const path = `shared/channels/${scope.channelId}/markup/${slugForTitle(title)}-${params.handle}.md`;

  const existing = await latestArtifactAtPath(pool, scope.workspaceId, path);
  if (existing) {
    return { artifactId: existing.artifactId, path, seq: existing.seq, workspaceId: scope.workspaceId, created: false };
  }

  const extractedAt = new Date().toISOString();
  const bytes = Buffer.from(renderMarkdownArtifact({
    handle: params.handle,
    entry: params.entry,
    title,
    userId: params.userId,
    sessionId: scope.sessionId,
    extractedAt,
  }), 'utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const s3Key = casBlobKey(sha);

  await uploadObject(s3Key, bytes, MARKDOWN_MIME);

  const ledger = new ArtifactLedger(pool);
  const committed = await withTx(pool, async (client) => {
    const locked = await getOrCreateMarkupArtifactLocked(client, {
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      path,
    });
    const latest = await ledger.latestVersion(client, locked.artifactId);
    if (latest) {
      return { artifactId: locked.artifactId, seq: latest.seq, created: false };
    }

    await ledger.upsertBlob(client, {
      sha256: sha,
      sizeBytes: bytes.byteLength,
      mime: MARKDOWN_MIME,
      s3Key,
      classification: classifyMediaFromMime(MARKDOWN_MIME),
    });
    await ledger.insertVersion(client, {
      artifactId: locked.artifactId,
      seq: 1,
      blobSha: sha,
      baseSeq: null,
      author: `human:${params.userId}`,
      kind: 'created',
      sourceMessageId: scope.sourceMessageId ?? null,
    });
    await ledger.advancePointer(client, locked.artifactId, 'latest', 1);
    return { artifactId: locked.artifactId, seq: 1, created: true };
  });

  return { ...committed, path, workspaceId: scope.workspaceId };
}

async function resolveExtractScope(db: Db, handle: string): Promise<EntryScope> {
  const decoded = decodeHandle(handle);
  switch (decoded.type) {
    case 'event': {
      const res = await db.query<{
        workspace_id: string;
        channel_id: string | null;
        type: string;
        payload: Record<string, unknown>;
      }>(
        'SELECT workspace_id, channel_id, type, payload FROM events WHERE id = $1',
        [decoded.eventId],
      );
      const row = res.rows[0];
      if (!row?.channel_id) throw new Error(`entry scope not found for ${handle}`);
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        sourceMessageId: sourceMessageIdFromEvent(row.type, row.payload),
      };
    }
    case 'record': {
      const res = await db.query<{
        workspace_id: string;
        channel_id: string;
        session_id: string;
        event_type: string | null;
        event_payload: Record<string, unknown> | null;
      }>(
        `SELECT s.workspace_id,
                s.channel_id,
                s.id AS session_id,
                e.type AS event_type,
                e.payload AS event_payload
           FROM session_records r
           JOIN sessions s ON s.id = r.session_id
           LEFT JOIN events e ON e.id = r.event_id
          WHERE r.entry_uid = $1
          ORDER BY r.ts DESC, r.session_id ASC, r.seq ASC
          LIMIT 1`,
        [decoded.entryUid],
      );
      const row = res.rows[0];
      if (!row) throw new Error(`entry scope not found for ${handle}`);
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        sessionId: row.session_id,
        sourceMessageId: sourceMessageIdFromEvent(row.event_type, row.event_payload),
      };
    }
    case 'artifact': {
      const res = await db.query<{ workspace_id: string; channel_id: string | null }>(
        'SELECT workspace_id, channel_id FROM artifacts WHERE id = $1',
        [decoded.artifactId],
      );
      const row = res.rows[0];
      if (!row?.channel_id) throw new Error(`entry scope not found for ${handle}`);
      return { workspaceId: row.workspace_id, channelId: row.channel_id };
    }
  }
}

function sourceMessageIdFromEvent(type: string | null, payload: Record<string, unknown> | null): string | null {
  if (type !== 'message.posted') return null;
  const value = payload?.client_msg_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

async function latestArtifactAtPath(
  db: Db,
  workspaceId: string,
  path: string,
): Promise<{ artifactId: string; seq: number } | null> {
  const res = await db.query<{ artifact_id: string; seq: number }>(
    `SELECT a.id AS artifact_id, v.seq
       FROM artifacts a
       JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
      WHERE a.workspace_id = $1 AND a.path = $2`,
    [workspaceId, path],
  );
  const row = res.rows[0];
  return row ? { artifactId: row.artifact_id, seq: row.seq } : null;
}

async function getOrCreateMarkupArtifactLocked(
  client: DbClient,
  params: { workspaceId: string; channelId: string; path: string },
): Promise<{ artifactId: string }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO artifacts (workspace_id, session_id, channel_id, path, merge_class)
     VALUES ($1, NULL, $2, $3, 'mergeable-doc')
     ON CONFLICT (workspace_id, path) DO NOTHING
     RETURNING id`,
    [params.workspaceId, params.channelId, params.path],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return { artifactId: insertedId };

  const locked = await client.query<{ id: string }>(
    'SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2 FOR UPDATE',
    [params.workspaceId, params.path],
  );
  return { artifactId: locked.rows[0]!.id };
}

function renderMarkdownArtifact(params: {
  handle: string;
  entry: NormalizedEntry;
  title: string;
  userId: string;
  sessionId?: string;
  extractedAt: string;
}): string {
  const frontmatter = [
    '---',
    `source_entry: ${yamlString(params.handle)}`,
    `source_kind: ${yamlString(params.entry.kind)}`,
    ...(params.sessionId ? [`session: ${yamlString(params.sessionId)}`] : []),
    `title: ${yamlString(params.title)}`,
    `extracted_by: ${yamlString(params.userId)}`,
    `extracted_at: ${yamlString(params.extractedAt)}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}\n${params.entry.text}`;
}

function deriveTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
  return words || 'Untitled entry';
}

function slugForTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'entry';
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
