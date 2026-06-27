import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { UserRef } from './events.js';
import { readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import { firstHeader } from './artifact-route-utils.js';
import { workspaceIdsFor } from './membership.js';
import type { SessionRuns } from './session-runs.js';

export interface AppAccessContext {
  activeWorkspaceIdFor(userId: string): Promise<string | null>;
  canViewFull(userId: string): Promise<boolean>;
  fullViewForbidden(reply: FastifyReply): FastifyReply;
  noWorkspace(reply: FastifyReply): FastifyReply;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
  resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null>;
  serializeArtifactRoots(roots: readonly ArtifactScopeRoot[]): SerializedArtifactRoot[];
  sessionArtifactAccess(sessionId: string, userId?: string | null): ReturnType<typeof readableArtifactRootsForSession>;
}

export interface InternalSessionRef {
  id: string;
  channelId: string;
  workspaceId: string;
}

export interface SerializedArtifactRoot {
  prefix: string;
  scope: ArtifactScopeRoot['kind'];
  writable: boolean;
}

export function createAppAccessContext(args: {
  artifactCaptureApiKey: string | undefined;
  fullViewEnabled: boolean;
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  sessionRuns: SessionRuns;
}): AppAccessContext {
  const { artifactCaptureApiKey, fullViewEnabled, pool, requireUser, sessionRuns } = args;

  async function canViewFull(userId: string): Promise<boolean> {
    if (!fullViewEnabled) return false;
    const res = await pool.query<{ raw_access: boolean }>(`SELECT raw_access FROM users WHERE id = $1`, [userId]);
    return res.rows[0]?.raw_access === true;
  }

  function fullViewForbidden(reply: FastifyReply) {
    return reply.code(403).send({ error: 'full_view_forbidden' });
  }

  async function activeWorkspaceIdFor(userId: string): Promise<string | null> {
    return (await workspaceIdsFor(pool, userId))[0] ?? null;
  }

  function noWorkspace(reply: FastifyReply) {
    return reply.code(403).send({ error: 'no_workspace', message: 'user has no workspace' });
  }

  async function resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null> {
    const res = await pool.query<{ id: string; channel_id: string; workspace_id: string }>(
      `SELECT id, channel_id, workspace_id
         FROM sessions
        WHERE id::text = $1 OR centaur_thread_key = $1
        LIMIT 1`,
      [sessionRef],
    );
    const row = res.rows[0];
    return row ? { id: row.id, channelId: row.channel_id, workspaceId: row.workspace_id } : null;
  }

  async function sessionArtifactAccess(sessionId: string, userId?: string | null) {
    return readableArtifactRootsForSession(pool, sessionId, userId);
  }

  function serializeArtifactRoots(roots: readonly ArtifactScopeRoot[]) {
    return roots.map((root) => ({
      prefix: root.prefix,
      scope: root.kind,
      writable: root.writable,
    }));
  }

  const requireCaptureKey = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const key = firstHeader(req.headers['x-api-key']);
    if (!artifactCaptureApiKey || key !== artifactCaptureApiKey) {
      reply.code(401).send({ error: 'unauthorized', message: 'x-api-key required' });
      return false;
    }
    return true;
  };

  async function requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null> {
    const user = requireUser(req, reply);
    if (!user) return null;
    const { id } = req.params as { id: string };
    if (!(await sessionRuns.userCanAccessSession(id, user.id))) {
      reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
      return null;
    }
    return user;
  }

  return {
    activeWorkspaceIdFor,
    canViewFull,
    fullViewForbidden,
    noWorkspace,
    requireCaptureKey,
    requireSessionAccess,
    resolveInternalSessionRef,
    serializeArtifactRoots,
    sessionArtifactAccess,
  };
}
