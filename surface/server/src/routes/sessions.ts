import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db, DbClient } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import type { AgentProfiles } from '../agent-profiles.js';
import type { AppRegistry, AppScope } from '../app-registry.js';
import { classifyScope } from '../artifact-scope.js';
import { githubConnectionId, type Connections } from '../connections.js';
import type { SessionRuns } from '../session-runs.js';
import { GitHubRepoValidationError, validateGitHubAppInstallationRepos } from '../github-repo-validation.js';
import { githubPatSecretForeignId, IronControlRequestError, type IronControlAdminClient } from '../iron-control.js';

type GitHubIdentityMode = 'automatic' | 'app_installation' | 'app_user' | 'pat';

export interface SessionRouteDeps {
  pool: Db;
  sessionRuns: SessionRuns;
  connections: Connections;
  ironControl: IronControlAdminClient;
  agentProfiles: AgentProfiles;
  appRegistry: AppRegistry;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
  optionalOpId(body: unknown): string | undefined;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const {
    sessionRuns,
    connections,
    ironControl,
    agentProfiles,
    appRegistry,
    requireUser,
    requireSessionAccess,
    optionalOpId,
    runMutation,
  } = deps;

  async function sessionAppContext(sessionId: string): Promise<{ workspaceId: string; channelId: string } | null> {
    const res = await deps.pool.query<{ workspace_id: string; channel_id: string }>(
      'SELECT workspace_id, channel_id FROM sessions WHERE id = $1',
      [sessionId],
    );
    const row = res.rows[0];
    return row ? { workspaceId: row.workspace_id, channelId: row.channel_id } : null;
  }

  app.post('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      threadRootEventId?: number;
      task?: string;
      harness?: string;
      repo?: string;
      branch?: string;
      repos?: { repo?: unknown; ref?: unknown; subdir?: unknown; private?: unknown }[];
      githubIdentityMode?: unknown;
      agentProfileId?: string;
      agentProfileVersionId?: string;
      clientSpawnId?: unknown;
      opId?: unknown;
    };
    const opId = optionalOpId(body);
    const task = typeof body.task === 'string' ? body.task : '';
    const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : undefined;
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    const channelId = body.channelId;
    if (task.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_task', message: 'task is empty' });
    }
    if (Buffer.byteLength(task, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'task_too_large', message: 'task exceeds 8KB' });
    }
    const threadRootEventId = body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    if (!(await canAccessChannel(deps.pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const githubIdentityMode = normalizeGitHubIdentityMode(body.githubIdentityMode);
    if (!githubIdentityMode) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'githubIdentityMode must be automatic, app_installation, app_user, or pat',
      });
    }
    const privateRepos = privateGitHubRepos(body);
    const privateRepoRequested = privateRepos.length > 0;
    const spawnWithGitHubState = async () => {
      const githubConnection =
        privateRepoRequested || githubIdentityMode !== 'automatic'
          ? await connectedGitHubForChannel(deps.pool, user.id, channelId)
          : null;
      const credentialOwnerUserId = githubConnection?.user_id ?? null;
      if (privateRepoRequested && !githubConnection) {
        return reply.code(409).send({
          error: 'github_connection_required',
          message: 'Connect GitHub before starting a session with private repositories.',
        });
      }
      if (
        githubIdentityMode !== 'automatic' &&
        (!githubConnection || githubConnection.token_kind !== githubIdentityMode)
      ) {
        return reply.code(409).send({
          error: 'github_identity_unavailable',
          message: `Connect GitHub with ${githubIdentityMode} credentials before using that identity mode.`,
        });
      }
      if (privateRepoRequested && githubConnection?.token_kind === 'app_installation') {
        const installationId = metadataString(githubConnection.metadata, 'installationId');
        if (!installationId) {
          return reply.code(409).send({
            error: 'github_repo_access_unverified',
            message: 'Reconnect the GitHub App installation before starting a session with private repositories.',
          });
        }
        try {
          const validation = await validateGitHubAppInstallationRepos(
            {
              appId: config.githubAppId,
              privateKey: config.githubAppPrivateKey,
              privateKeyId: config.githubAppPrivateKeyId || undefined,
              installationId,
            },
            privateRepos,
          );
          if (validation.inaccessible.length > 0) {
            return reply.code(409).send({
              error: 'github_repo_inaccessible',
              message: `Connected GitHub credentials cannot access: ${validation.inaccessible.join(', ')}`,
              repos: validation.inaccessible,
            });
          }
        } catch (err) {
          if (err instanceof GitHubRepoValidationError && err.code === 'unconfigured') {
            return reply.code(503).send({
              error: 'github_repo_validation_unconfigured',
              message: 'GitHub App repository validation is not configured.',
            });
          }
          req.log.warn({ err }, 'github repo access validation failed');
          return reply.code(502).send({
            error: 'github_repo_validation_failed',
            message: 'Could not validate GitHub repository access.',
          });
        }
      }
      if (privateRepoRequested && githubConnection?.token_kind === 'app_user') {
        const brokerCredentialId = metadataString(githubConnection.metadata, 'brokerCredentialId');
        if (!brokerCredentialId) {
          return reply.code(409).send({
            error: 'github_repo_access_unverified',
            message: 'Reconnect GitHub before starting a session with private repositories.',
          });
        }
        try {
          const validation = await ironControl.validateGitHubBrokerRepos(brokerCredentialId, privateRepos);
          if (validation.inaccessible.length > 0) {
            return reply.code(409).send({
              error: 'github_repo_inaccessible',
              message: `Connected GitHub credentials cannot access: ${validation.inaccessible.join(', ')}`,
              repos: validation.inaccessible,
            });
          }
        } catch (err) {
          if (err instanceof IronControlRequestError && err.status === 409) {
            return reply.code(409).send({
              error: 'github_repo_access_unverified',
              message: 'Reconnect GitHub before starting a session with private repositories.',
            });
          }
          req.log.warn({ err }, 'github broker repo access validation failed');
          return reply.code(502).send({
            error: 'github_repo_validation_failed',
            message: 'Could not validate GitHub repository access.',
          });
        }
      }
      if (privateRepoRequested && githubConnection?.token_kind === 'pat') {
        const staticSecretId =
          metadataString(githubConnection.metadata, 'staticSecretId') ??
          metadataString(githubConnection.metadata, 'staticSecretForeignId') ??
          githubPatSecretForeignId(githubConnection.workspace_id, githubConnection.user_id);
        try {
          const validation = await ironControl.validateGitHubStaticSecretRepos(staticSecretId, privateRepos);
          if (validation.inaccessible.length > 0) {
            return reply.code(409).send({
              error: 'github_repo_inaccessible',
              message: `Connected GitHub credentials cannot access: ${validation.inaccessible.join(', ')}`,
              repos: validation.inaccessible,
            });
          }
        } catch (err) {
          if (err instanceof IronControlRequestError && err.status === 409) {
            return reply.code(409).send({
              error: 'github_repo_access_unverified',
              message: 'Reconnect GitHub before starting a session with private repositories.',
            });
          }
          req.log.warn({ err }, 'github PAT repo access validation failed');
          return reply.code(502).send({
            error: 'github_repo_validation_failed',
            message: 'Could not validate GitHub repository access.',
          });
        }
      }
      const resolvedGitHubIdentityMode =
        githubIdentityMode === 'automatic' && githubConnection?.token_kind
          ? githubConnection.token_kind
          : githubIdentityMode;
      const providerConnectionId =
        resolvedGitHubIdentityMode !== 'automatic' && githubConnection ? githubConnection.connection_id : null;
      const clientSpawnId =
        typeof body.clientSpawnId === 'string' && body.clientSpawnId.length <= 80 ? body.clientSpawnId : undefined;
      const agentProfileId =
        typeof body.agentProfileId === 'string' && body.agentProfileId.trim() ? body.agentProfileId.trim() : undefined;
      const agentProfileVersionId =
        typeof body.agentProfileVersionId === 'string' && body.agentProfileVersionId.trim()
          ? body.agentProfileVersionId.trim()
          : undefined;
      let createdSession: Awaited<ReturnType<SessionRuns['createSessionInTx']>> | null = null;
      const result = await runMutation({
        userId: user.id,
        opId,
        opType: 'session.spawn',
        body: {
          channelId,
          threadRootEventId,
          task,
          harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
          repo,
          branch,
          repos: Array.isArray(body.repos) ? body.repos : undefined,
          githubIdentityMode: resolvedGitHubIdentityMode,
          providerConnectionId,
          providerCredentialUserId: credentialOwnerUserId,
          agentProfileId,
          agentProfileVersionId,
          clientSpawnId,
        },
        fn: async (client) => {
          createdSession = await sessionRuns.createSessionInTx(client, {
            channelId,
            threadRootEventId,
            task,
            harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
            repo,
            branch,
            repos: Array.isArray(body.repos) ? body.repos : undefined,
            githubIdentityMode: resolvedGitHubIdentityMode,
            providerConnectionId,
            providerCredentialUserId: credentialOwnerUserId,
            agentProfileId,
            agentProfileVersionId,
            clientSpawnId,
            user,
          });
          return { session: createdSession.session, created: createdSession.created };
        },
        onApplied: () => {
          if (createdSession) sessionRuns.afterCreateSession(createdSession, task);
        },
      });
      return reply.code(result.created ? 201 : 200).send({ session: result.session });
    };
    if (privateRepoRequested || githubIdentityMode !== 'automatic') {
      const workspaceId = await workspaceIdForChannel(deps.pool, channelId);
      if (!workspaceId) return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
      return connections.withConnectionLock(workspaceId, user.id, 'github', spawnWithGitHubState);
    }
    return spawnWithGitHubState();
  });

  app.get('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { status?: string; limit?: string };
    const status =
      q.status === 'running' || q.status === 'recent' || q.status === 'all'
        ? q.status
        : q.status == null
          ? 'all'
          : null;
    if (!status) {
      return reply.code(400).send({ error: 'bad_query', message: 'invalid status filter' });
    }
    const rawLimit = q.limit == null ? 50 : Number(q.limit);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'limit must be positive' });
    }
    const limit = Math.min(200, Math.floor(rawLimit));
    return { sessions: await sessionRuns.listSessionsForUser({ userId: user.id, status, limit }) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { session: await sessionRuns.getSessionForUser(id, user.id) };
  });

  app.get('/api/sessions/:id/profile-change-proposals', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { proposals: await agentProfiles.listSessionProposals(id, user.id) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/discard', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    return { proposal: await agentProfiles.discardProposal(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/apply-lineage', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    return { proposal: await agentProfiles.applyProposalToLineage(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-current-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { profileId?: unknown; name?: unknown };
    return await agentProfiles.saveProposalToCurrentProfile(user.id, id, proposalId, {
      ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    });
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-new-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    return await agentProfiles.saveProposalToNewProfile(user.id, id, proposalId, name);
  });

  app.get('/api/sessions/:id/record', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const record = await sessionRuns.getSessionRecord(id);
    record.artifacts = record.artifacts.map((artifact) => ({
      ...artifact,
      scope: classifyScope(artifact.path),
    }));
    return { record };
  });

  app.post('/api/sessions/:id/apps', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; entry?: unknown; scope?: unknown };
    if (typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'name is required' });
    }
    const scope: AppScope = body.scope === 'workspace' ? 'workspace' : 'channel';
    const entry = typeof body.entry === 'string' && body.entry.trim() ? body.entry : 'index.html';
    const ctx = await sessionAppContext(id);
    if (!ctx) return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    const published = await appRegistry.publish({
      sessionId: id,
      workspaceId: ctx.workspaceId,
      channelId: ctx.channelId,
      userId: user.id,
      name: body.name,
      scope,
      entry,
    });
    return reply.send(published);
  });

  app.get('/api/apps', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return reply.send({ apps: await appRegistry.listForUser(user.id) });
  });

  app.post('/api/apps/:appId/launch', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { appId } = req.params as { appId: string };
    const body = (req.body ?? {}) as { version?: unknown };
    const version = body.version == null ? undefined : Number(body.version);
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
      return reply.code(400).send({ error: 'bad_request', message: 'version must be a positive integer' });
    }
    return reply.send(await appRegistry.launch(appId, user.id, version));
  });
}

function privateGitHubRepos(body: {
  repo?: string;
  repos?: { repo?: unknown; ref?: unknown; subdir?: unknown; private?: unknown }[];
}): string[] {
  if (!Array.isArray(body.repos)) return [];
  const repos = new Set<string>();
  for (const repo of body.repos) {
    if (repo?.private !== true || typeof repo.repo !== 'string') continue;
    const normalized = repo.repo.trim();
    if (normalized) repos.add(normalized);
  }
  return [...repos];
}

async function workspaceIdForChannel(pool: Db, channelId: string): Promise<string | null> {
  const res = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
    channelId,
  ]);
  return res.rows[0]?.workspace_id ?? null;
}

async function connectedGitHubForChannel(
  pool: Db,
  userId: string,
  channelId: string,
): Promise<{
  connection_id: string;
  workspace_id: string;
  user_id: string;
  token_kind: string | null;
  metadata: unknown;
} | null> {
  const res = await pool.query<{ workspace_id: string; user_id: string; token_kind: string | null; metadata: unknown }>(
    `SELECT uc.workspace_id, uc.user_id, uc.token_kind, uc.metadata
       FROM channels c
       JOIN user_connections uc
         ON uc.workspace_id = c.workspace_id
        AND uc.user_id = $2
        AND uc.provider = 'github'
        AND uc.status = 'connected'
      WHERE c.id = $1
      LIMIT 1`,
    [channelId, userId],
  );
  const row = res.rows[0];
  return row ? { ...row, connection_id: githubConnectionId({ tokenKind: row.token_kind, metadata: row.metadata }) } : null;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeGitHubIdentityMode(value: unknown): GitHubIdentityMode | null {
  if (value == null || value === '') return 'automatic';
  if (value === 'automatic' || value === 'app_installation' || value === 'app_user' || value === 'pat') {
    return value;
  }
  return null;
}
