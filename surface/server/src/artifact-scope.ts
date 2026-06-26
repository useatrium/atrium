import type { Db, DbClient } from './db.js';
import { workspaceMemberExists } from './membership.js';

export type ArtifactScope = 'private' | 'topic' | 'workspace';

export interface ArtifactScopeRoot {
  prefix: string;
  kind: ArtifactScope;
  writable: boolean;
}

export function classifyScope(path: string): ArtifactScope {
  if (isCanonicalSharedPath(path)) return 'workspace';
  return 'private';
}

export function userCanReadScope(scope: ArtifactScope): boolean {
  return scope !== 'private';
}

export function isCanonicalSharedPath(path: string): boolean {
  return (
    /^shared\/global\/.+/.test(path) ||
    /^shared\/channels\/[^/]+\/.+/.test(path) ||
    // Flat workspace app convention: shared/apps/<slug>/... (presented artifacts +
    // the apps registry). Workspace-readable like shared/global.
    /^shared\/apps\/[^/]+\/.+/.test(path)
  );
}

export function isSessionScratchPath(path: string, sessionId: string): boolean {
  return path.startsWith(`scratch/${sessionId}/`);
}

export function userCanReadSessionArtifactPath(path: string, sessionId: string): boolean {
  return isCanonicalSharedPath(path) || isSessionScratchPath(path, sessionId);
}

export function artifactPathInRoots(path: string, roots: readonly ArtifactScopeRoot[]): boolean {
  return roots.some((root) => path.startsWith(`${root.prefix}/`));
}

export async function readableArtifactRootsForSession(
  db: Db | DbClient,
  sessionId: string,
  userId?: string | null,
): Promise<{
  sessionId: string;
  workspaceId: string;
  channelId: string;
  userId: string | null;
  activePrefix: string;
  readableChannelIds: string[];
  readableRoots: ArtifactScopeRoot[];
  writableRoots: ArtifactScopeRoot[];
}> {
  const session = await db.query<{
    workspace_id: string;
    channel_id: string;
    actor_user_id: string | null;
  }>(
    `SELECT workspace_id, channel_id, COALESCE(driver_id, spawned_by) AS actor_user_id
       FROM sessions
      WHERE id = $1`,
    [sessionId],
  );
  const row = session.rows[0];
  if (!row) throw new Error(`session not found: ${sessionId}`);

  const actorUserId = userId ?? row.actor_user_id;
  let readableChannelIds: string[];
  if (actorUserId) {
    const channels = await db.query<{ id: string }>(
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
      [row.workspace_id, actorUserId, row.channel_id],
    );
    readableChannelIds = channels.rows.map((channel) => channel.id);
  } else {
    readableChannelIds = [row.channel_id];
  }
  if (!readableChannelIds.includes(row.channel_id)) readableChannelIds.unshift(row.channel_id);

  const activePrefix = `shared/channels/${row.channel_id}`;
  const readableRoots: ArtifactScopeRoot[] = [
    { prefix: `scratch/${sessionId}`, kind: 'private', writable: true },
    { prefix: 'shared/global', kind: 'workspace', writable: true },
    { prefix: 'shared/apps', kind: 'workspace', writable: true },
    ...readableChannelIds.map((id) => ({
      prefix: `shared/channels/${id}`,
      kind: 'workspace' as const,
      writable: true,
    })),
  ];
  const deduped = dedupeRoots(readableRoots);
  return {
    sessionId,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    userId: actorUserId,
    activePrefix,
    readableChannelIds,
    readableRoots: deduped,
    writableRoots: deduped.filter((root) => root.writable),
  };
}

function dedupeRoots(roots: ArtifactScopeRoot[]): ArtifactScopeRoot[] {
  const seen = new Set<string>();
  const result: ArtifactScopeRoot[] = [];
  for (const root of roots) {
    if (seen.has(root.prefix)) continue;
    seen.add(root.prefix);
    result.push(root);
  }
  return result;
}
