import { basename } from 'node:path';
import type { MessagePart } from '@atrium/centaur-client';
import { ArtifactLedger, type ResolvedVersion, type VersionRef } from './artifact-ledger.js';
import { artifactPathInRoots, readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import {
  canonicalizeSessionArtifactPath,
  canonicalizeWorkspaceArtifactPath,
  displaySessionArtifactPath,
  InvalidArtifactPathError,
} from './artifact-path.js';
import type { Db } from './db.js';
import { DomainError } from './events.js';
import { workspaceMemberExists } from './membership.js';
import { landUploadAttachmentAsArtifact, type UploadAttachmentFileRow } from './upload-artifacts.js';

const MAX_AGENT_TURN_ATTACHMENTS = 10;

export type AgentTurnAttachmentInput =
  | { source: 'upload'; id: string }
  | { source: 'artifact'; path?: string; artifactId?: string; ref: VersionRef };

export interface AgentTurnAttachmentRef {
  source: 'upload' | 'artifact';
  id: string;
  name: string;
  contentType: string;
  size: number;
  artifactId: string;
  artifactPath: string;
  artifactSeq: number;
  blobSha: string;
  workspacePath: string;
  displayPath: string;
}

interface ArtifactAccessContext {
  workspaceId: string;
  channelId: string;
  sessionId?: string;
  readableChannelIds: string[];
  readableRoots: ArtifactScopeRoot[];
}

export function parseAgentTurnAttachmentInputs(value: unknown): AgentTurnAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_AGENT_TURN_ATTACHMENTS) {
    throw new DomainError(400, 'bad_attachment', `at most ${MAX_AGENT_TURN_ATTACHMENTS} attachments are allowed`);
  }
  return value.map((item): AgentTurnAttachmentInput => {
    const parsed = parseAgentTurnAttachmentInput(item);
    if (!parsed) throw new DomainError(400, 'bad_attachment', 'invalid attachment reference');
    return parsed;
  });
}

export function parseAgentTurnAttachmentInputPayloads(...values: unknown[]): AgentTurnAttachmentInput[] {
  const inputs = values.flatMap((value) => parseAgentTurnAttachmentInputs(value));
  if (inputs.length > MAX_AGENT_TURN_ATTACHMENTS) {
    throw new DomainError(400, 'bad_attachment', `at most ${MAX_AGENT_TURN_ATTACHMENTS} attachments are allowed`);
  }
  return inputs;
}

function parseAgentTurnAttachmentInput(value: unknown): AgentTurnAttachmentInput | null {
  if (typeof value === 'string') {
    return value.trim() ? { source: 'upload', id: value } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source =
    typeof record.source === 'string'
      ? record.source
      : typeof record.type === 'string'
        ? record.type
        : typeof record.kind === 'string'
          ? record.kind
          : undefined;
  const id = stringField(record.id) ?? stringField(record.fileId) ?? stringField(record.uploadId);
  if ((source === 'upload' || (!source && id)) && id) {
    return { source: 'upload', id };
  }
  const path = stringField(record.path) ?? stringField(record.artifactPath);
  const artifactId = stringField(record.artifactId) ?? (source === 'artifact' ? id : undefined);
  if ((source === 'artifact' || path || artifactId) && (path || artifactId)) {
    return { source: 'artifact', path, artifactId, ref: artifactVersionRef(record) };
  }
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function artifactVersionRef(record: Record<string, unknown>): VersionRef {
  const seq = Number(record.seq ?? record.artifactSeq ?? record.versionSeq);
  if (Number.isSafeInteger(seq) && seq > 0) return { seq };
  const at = stringField(record.at);
  if (at && /^\d+$/.test(at)) return { seq: Number(at) };
  return { pointer: stringField(record.pointer) ?? at ?? 'latest' };
}

export async function resolveAgentTurnAttachments(
  pool: Db,
  params: {
    userId: string;
    channelId?: string;
    sessionId?: string;
    inputs: readonly AgentTurnAttachmentInput[];
    logger?: { warn(obj: unknown, msg?: string): void };
  },
): Promise<AgentTurnAttachmentRef[]> {
  if (params.inputs.length === 0) return [];
  const access = params.sessionId
    ? await sessionAccess(pool, params.sessionId, params.userId)
    : await channelAccess(pool, requiredChannelId(params.channelId), params.userId);
  if (params.channelId && access.channelId !== params.channelId) {
    throw new DomainError(400, 'channel_mismatch', 'session belongs to another channel');
  }

  const uploadIds = [
    ...new Set(
      params.inputs
        .filter((input): input is Extract<AgentTurnAttachmentInput, { source: 'upload' }> => input.source === 'upload')
        .map((input) => input.id),
    ),
  ];
  const uploadsById =
    uploadIds.length > 0
      ? await loadUserUploadFiles(pool, params.userId, uploadIds)
      : new Map<string, UploadAttachmentFileRow>();

  const refs: AgentTurnAttachmentRef[] = [];
  for (const input of params.inputs) {
    if (input.source === 'upload') {
      const file = uploadsById.get(input.id);
      if (!file) {
        throw new DomainError(400, 'bad_attachment', 'unknown or foreign attachment id');
      }
      refs.push(await resolveUploadAttachment(pool, access, params.userId, file, params.logger));
    } else {
      refs.push(await resolveExistingArtifact(pool, access, input));
    }
  }
  return refs;
}

async function loadUserUploadFiles(
  pool: Db,
  userId: string,
  uploadIds: readonly string[],
): Promise<Map<string, UploadAttachmentFileRow>> {
  const rows = await pool.query<UploadAttachmentFileRow>(
    `SELECT id, filename, content_type, size_bytes, width, height, s3_key, content_hash
       FROM files
      WHERE id = ANY($1::uuid[]) AND uploader_id = $2`,
    [uploadIds, userId],
  );
  if (rows.rows.length !== uploadIds.length) {
    throw new DomainError(400, 'bad_attachment', 'unknown or foreign attachment id');
  }
  return new Map(rows.rows.map((row) => [row.id, row]));
}

async function resolveUploadAttachment(
  pool: Db,
  access: ArtifactAccessContext,
  userId: string,
  file: UploadAttachmentFileRow,
  logger?: { warn(obj: unknown, msg?: string): void },
): Promise<AgentTurnAttachmentRef> {
  if (file.content_hash == null) {
    throw new DomainError(409, 'attachment_not_ready', 'attachment bytes are not durable yet');
  }
  const landed = await landUploadAttachmentAsArtifact(pool, {
    channelId: access.channelId,
    userId,
    file,
    logger,
  });
  return {
    source: 'upload',
    id: file.id,
    name: file.filename,
    contentType: file.content_type,
    size: Number(file.size_bytes),
    artifactId: landed.artifactId,
    artifactPath: landed.path,
    artifactSeq: landed.seq,
    blobSha: landed.blobSha,
    workspacePath: workspacePathForArtifact(landed.path),
    displayPath: displayPath(landed.path, access),
  };
}

async function resolveExistingArtifact(
  pool: Db,
  access: ArtifactAccessContext,
  input: Extract<AgentTurnAttachmentInput, { source: 'artifact' }>,
): Promise<AgentTurnAttachmentRef> {
  const path = input.path
    ? canonicalizeAttachmentPath(input.path, access)
    : await pathForArtifactId(pool, access.workspaceId, requiredArtifactId(input.artifactId));
  if (!artifactPathInRoots(path, access.readableRoots)) {
    throw new DomainError(404, 'artifact_not_found', 'artifact not found');
  }

  const version = access.sessionId
    ? await new ArtifactLedger(pool).resolveVersion(access.sessionId, path, input.ref, {
        readableChannelIds: access.readableChannelIds,
      })
    : await resolveWorkspaceArtifactVersion(pool, access.workspaceId, path, input.ref);
  if (!version || version.kind === 'deleted' || version.tombstoned) {
    throw new DomainError(404, 'artifact_not_found', 'artifact not found');
  }
  if (!version.blobSha || !version.s3Key) {
    throw new DomainError(503, 'blob_unavailable', 'artifact bytes are not durable in CAS');
  }
  return {
    source: 'artifact',
    id: version.artifactId,
    name: basename(path) || 'artifact',
    contentType: version.mime ?? version.detectedMime ?? 'application/octet-stream',
    size: Number(version.sizeBytes ?? 0),
    artifactId: version.artifactId,
    artifactPath: path,
    artifactSeq: version.seq,
    blobSha: version.blobSha,
    workspacePath: workspacePathForArtifact(path),
    displayPath: displayPath(path, access),
  };
}

async function resolveWorkspaceArtifactVersion(
  pool: Db,
  workspaceId: string,
  path: string,
  ref: VersionRef,
): Promise<ResolvedVersion | null> {
  const artifact = await pool.query<{ id: string }>('SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2', [
    workspaceId,
    path,
  ]);
  const artifactId = artifact.rows[0]?.id;
  if (!artifactId) return null;
  return new ArtifactLedger(pool).resolveVersionByArtifactId(artifactId, ref);
}

async function pathForArtifactId(pool: Db, workspaceId: string, artifactId: string): Promise<string> {
  const artifact = await pool.query<{ path: string }>(
    'SELECT path FROM artifacts WHERE workspace_id = $1 AND id = $2',
    [workspaceId, artifactId],
  );
  const path = artifact.rows[0]?.path;
  if (!path) throw new DomainError(404, 'artifact_not_found', 'artifact not found');
  return path;
}

function canonicalizeAttachmentPath(path: string, access: ArtifactAccessContext): string {
  try {
    return access.sessionId
      ? canonicalizeSessionArtifactPath(path, {
          sessionId: access.sessionId,
          channelId: access.channelId,
          readableChannelIds: access.readableChannelIds,
        })
      : canonicalizeWorkspaceArtifactPath(path, {
          channelId: access.channelId,
          readableChannelIds: access.readableChannelIds,
        });
  } catch (err) {
    if (err instanceof InvalidArtifactPathError) {
      throw new DomainError(400, 'bad_attachment', err.message);
    }
    throw err;
  }
}

function requiredChannelId(channelId: string | undefined): string {
  if (!channelId) throw new DomainError(400, 'bad_request', 'channelId required');
  return channelId;
}

function requiredArtifactId(artifactId: string | undefined): string {
  if (!artifactId) throw new DomainError(400, 'bad_attachment', 'artifactId or path required');
  return artifactId;
}

async function sessionAccess(pool: Db, sessionId: string, userId: string): Promise<ArtifactAccessContext> {
  const access = await readableArtifactRootsForSession(pool, sessionId, userId);
  return {
    sessionId,
    workspaceId: access.workspaceId,
    channelId: access.channelId,
    readableChannelIds: access.readableChannelIds,
    readableRoots: access.readableRoots,
  };
}

async function channelAccess(pool: Db, channelId: string, userId: string): Promise<ArtifactAccessContext> {
  const channel = await pool.query<{
    workspace_id: string;
  }>('SELECT workspace_id FROM channels WHERE id = $1', [channelId]);
  const workspaceId = channel.rows[0]?.workspace_id;
  if (!workspaceId) throw new DomainError(404, 'channel_not_found', 'channel not found');
  const channels = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM channels c
      WHERE c.workspace_id = $1
        AND (
          (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$2')})
          OR EXISTS (
            SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = c.id AND cm.user_id = $2
          )
          OR c.id = $3
        )
      ORDER BY c.id ASC`,
    [workspaceId, userId, channelId],
  );
  const readableChannelIds = channels.rows.map((row) => row.id);
  if (!readableChannelIds.includes(channelId)) readableChannelIds.unshift(channelId);
  const readableRoots: ArtifactScopeRoot[] = [
    { prefix: 'shared/global', kind: 'workspace', writable: true },
    { prefix: 'shared/apps', kind: 'workspace', writable: true },
    ...readableChannelIds.map((id) => ({
      prefix: `shared/channels/${id}`,
      kind: 'workspace' as const,
      writable: id === channelId,
    })),
  ];
  return { workspaceId, channelId, readableChannelIds, readableRoots };
}

function workspacePathForArtifact(path: string): string {
  return `/workspace/${path}`;
}

function displayPath(path: string, access: ArtifactAccessContext): string {
  return access.sessionId
    ? displaySessionArtifactPath(path, { sessionId: access.sessionId, channelId: access.channelId })
    : path.startsWith(`shared/channels/${access.channelId}/`)
      ? path.slice(`shared/channels/${access.channelId}/`.length)
      : path;
}

export function agentTurnMessageParts(
  text: string,
  attachments: readonly AgentTurnAttachmentRef[] = [],
  contextBlock?: string,
): MessagePart[] {
  const parts: MessagePart[] = [];
  if (contextBlock) parts.push({ type: 'context', text: contextBlock });
  if (text.trim()) parts.push({ type: 'text', text });
  for (const attachment of attachments) parts.push(agentAttachmentBlock(attachment));
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

export function agentTurnInputLine(
  text: string,
  attachments: readonly AgentTurnAttachmentRef[] = [],
  effort?: string | null,
  contextBlock?: string,
  clientUserMessageId?: string,
): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: agentTurnMessageParts(text, attachments, contextBlock),
    },
    ...(effort ? { reasoning: effort } : {}),
    ...(clientUserMessageId ? { client_user_message_id: clientUserMessageId } : {}),
  });
}

function agentAttachmentBlock(attachment: AgentTurnAttachmentRef): MessagePart {
  return {
    type: 'attachment',
    attachment_type: 'atrium-artifact',
    name: attachment.name,
    contentType: attachment.contentType,
    mimeType: attachment.contentType,
    localPath: attachment.workspacePath,
    path: attachment.workspacePath,
    artifactId: attachment.artifactId,
    artifactPath: attachment.artifactPath,
    artifactSeq: attachment.artifactSeq,
    blobSha: attachment.blobSha,
    required: true,
  };
}
