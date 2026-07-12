import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import {
  SaveAgentProfileProposalAsNewBodySchema,
  SaveAgentProfileProposalToCurrentBodySchema,
} from '@atrium/surface-client/agentProfiles';
import { config } from '../config.js';
import type { AppMutationContext } from '../app-mutations.js';
import type { Db } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import type { WsHub } from '../hub.js';
import type { AgentProfiles } from '../agent-profiles.js';
import type { AppRegistry, AppScope } from '../app-registry.js';
import { classifyScope } from '../artifact-scope.js';
import { githubConnectionId, type Connections } from '../connections.js';
import type { SessionRuns } from '../session-runs.js';
import { GitHubRepoValidationError, validateGitHubAppInstallationRepos } from '../github-repo-validation.js';
import { githubPatSecretForeignId, IronControlRequestError, type IronControlAdminClient } from '../iron-control.js';
import { convergeExistingGitHubDirectGrant, convergeGitHubExistingIdentityGrant } from '../github-iron-control.js';
import {
  parseAgentTurnAttachmentInputPayloads,
  resolveAgentTurnAttachments,
  type AgentTurnAttachmentRef,
} from '../session-attachments.js';
import { decodeRouteBody, decodeRouteParams, decodeRouteQuery } from '../route-schema.js';

type GitHubIdentityMode = 'automatic' | 'app_installation' | 'app_user' | 'pat';

const SessionSpawnBodySchema = Schema.Struct({
  channelId: Schema.optional(Schema.Unknown),
  threadRootEventId: Schema.optional(Schema.Unknown),
  task: Schema.optional(Schema.Unknown),
  harness: Schema.optional(Schema.Unknown),
  repo: Schema.optional(Schema.Unknown),
  branch: Schema.optional(Schema.Unknown),
  repos: Schema.optional(Schema.Unknown),
  githubIdentityMode: Schema.optional(Schema.Unknown),
  githubIdentityId: Schema.optional(Schema.Unknown),
  agentProfileId: Schema.optional(Schema.Unknown),
  agentProfileVersionId: Schema.optional(Schema.Unknown),
  attachments: Schema.optional(Schema.Unknown),
  attachmentRefs: Schema.optional(Schema.Unknown),
  clientSpawnId: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const SessionListQuerySchema = Schema.Struct({
  status: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
});

const SessionArchiveBodySchema = Schema.Struct({
  archived: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const SessionPinBodySchema = Schema.Struct({
  pinned: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const SessionParamsSchema = Schema.Struct({
  id: Schema.String,
});

const ProfileProposalParamsSchema = Schema.Struct({
  id: Schema.String,
  proposalId: Schema.String,
});

const PublishAppBodySchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  entry: Schema.optional(Schema.Unknown),
  scope: Schema.optional(Schema.Unknown),
});

const AppLaunchParamsSchema = Schema.Struct({
  appId: Schema.String,
});

const AppLaunchBodySchema = Schema.Struct({
  version: Schema.optional(Schema.Unknown),
});

export interface SessionRouteDeps extends AppMutationContext {
  pool: Db;
  hub: WsHub;
  sessionRuns: SessionRuns;
  connections: Connections;
  ironControl: IronControlAdminClient;
  agentProfiles: AgentProfiles;
  appRegistry: AppRegistry;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
}

async function validateDirectGitHubRepos(
  req: FastifyRequest,
  reply: FastifyReply,
  validate: () => Promise<{ inaccessible: string[] }>,
  failureLog: string,
) {
  try {
    const { inaccessible } = await validate();
    if (inaccessible.length > 0) {
      return reply.code(409).send({
        error: 'github_repo_inaccessible',
        message: `Connected GitHub credentials cannot access: ${inaccessible.join(', ')}`,
        repos: inaccessible,
      });
    }
  } catch (err) {
    if (err instanceof IronControlRequestError && err.status === 409) {
      return reply.code(409).send({
        error: 'github_repo_access_unverified',
        message: 'Reconnect GitHub before starting a session with private repositories.',
      });
    }
    req.log.warn({ err }, failureLog);
    return reply.code(502).send({
      error: 'github_repo_validation_failed',
      message: 'Could not validate GitHub repository access.',
    });
  }
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const {
    hub,
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
    const body = decodeRouteBody(SessionSpawnBodySchema, req.body);
    const opId = optionalOpId(body);
    const task = typeof body.task === 'string' ? body.task : '';
    const repo =
      typeof body.repo === 'string' && body.repo.trim()
        ? (normalizeGitHubRepoInput(body.repo.trim()) ?? body.repo.trim())
        : undefined;
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : undefined;
    const repos = normalizeSessionRepos(body.repos);
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
    const attachmentInputs = parseAgentTurnAttachmentInputPayloads(body.attachments, body.attachmentRefs);
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
    const githubIdentityId =
      typeof body.githubIdentityId === 'string' && body.githubIdentityId.trim() ? body.githubIdentityId.trim() : null;
    const privateRepos = privateGitHubRepos(repos);
    const privateRepoRequested = privateRepos.length > 0;
    const spawnWithGitHubState = async () => {
      let githubConnection =
        privateRepoRequested || githubIdentityMode !== 'automatic' || githubIdentityId
          ? await connectedGitHubForChannel(deps.pool, user.id, channelId)
          : null;
      if (githubIdentityId) {
        const selected = await selectGitHubIdentityForSpawn({
          connections,
          ironControl,
          pool: deps.pool,
          userId: user.id,
          channelId,
          identityId: githubIdentityId,
        });
        if (!selected.ok) {
          return reply.code(selected.status).send({ error: selected.error, message: selected.message });
        }
        githubConnection = selected.connection;
      }
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
        const validationError = await validateDirectGitHubRepos(
          req,
          reply,
          () => ironControl.validateGitHubBrokerRepos(brokerCredentialId, privateRepos),
          'github broker repo access validation failed',
        );
        if (validationError) return validationError;
      }
      if (privateRepoRequested && githubConnection?.token_kind === 'pat') {
        const staticSecretId =
          metadataString(githubConnection.metadata, 'staticSecretId') ??
          metadataString(githubConnection.metadata, 'staticSecretForeignId') ??
          githubPatSecretForeignId(githubConnection.workspace_id, githubConnection.user_id);
        const validationError = await validateDirectGitHubRepos(
          req,
          reply,
          () => ironControl.validateGitHubStaticSecretRepos(staticSecretId, privateRepos),
          'github PAT repo access validation failed',
        );
        if (validationError) return validationError;
      }
      if (
        privateRepoRequested &&
        githubConnection &&
        !githubIdentityId &&
        (githubConnection.token_kind === 'app_user' || githubConnection.token_kind === 'pat')
      ) {
        await convergeExistingGitHubDirectGrant(ironControl, {
          workspaceId: githubConnection.workspace_id,
          userId: githubConnection.user_id,
        });
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
      let initialAttachments: AgentTurnAttachmentRef[] = [];
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
          repos,
          githubIdentityMode: resolvedGitHubIdentityMode,
          githubIdentityId: githubConnection?.connection_id ?? null,
          providerConnectionId,
          providerCredentialUserId: credentialOwnerUserId,
          agentProfileId,
          agentProfileVersionId,
          clientSpawnId,
          attachments: attachmentInputs,
        },
        fn: async (client) => {
          initialAttachments = await resolveAgentTurnAttachments(deps.pool, {
            userId: user.id,
            channelId,
            inputs: attachmentInputs,
            logger: req.log,
          });
          createdSession = await sessionRuns.createSessionInTx(client, {
            channelId,
            threadRootEventId,
            task,
            harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
            repo,
            branch,
            repos,
            githubIdentityMode: resolvedGitHubIdentityMode,
            providerConnectionId,
            providerCredentialUserId: credentialOwnerUserId,
            agentProfileId,
            agentProfileVersionId,
            clientSpawnId,
            initialAttachments,
            user,
          });
          return { session: createdSession.session, created: createdSession.created };
        },
        onApplied: () => {
          if (createdSession) sessionRuns.afterCreateSession(createdSession, task, initialAttachments);
        },
      });
      return reply.code(result.created ? 201 : 200).send({ session: result.session });
    };
    if (privateRepoRequested || githubIdentityMode !== 'automatic' || githubIdentityId) {
      const workspaceId = await workspaceIdForChannel(deps.pool, channelId);
      if (!workspaceId) return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
      return connections.withConnectionLock(workspaceId, user.id, 'github', spawnWithGitHubState);
    }
    return spawnWithGitHubState();
  });

  app.get('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = decodeRouteQuery(SessionListQuerySchema, req.query);
    const status =
      q.status === 'running' || q.status === 'recent' || q.status === 'all' || q.status === 'archived'
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
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
    return { session: await sessionRuns.getSessionForUser(id, user.id) };
  });

  app.post('/api/sessions/:id/archive', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
    const body = decodeRouteBody(SessionArchiveBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.archived !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'archived must be boolean' });
    }
    const change = await runMutation({
      userId: user.id,
      opId,
      opType: 'session.archive',
      body: { sessionId: id, archived: body.archived },
      fn: (client) => sessionRuns.setArchiveStateInTx(client, id, user.id, body.archived as boolean),
      onApplied: (result) => {
        if (result.event) hub.publishEvent(result.event);
      },
    });
    return { archived: body.archived, archivedAt: change.archivedAt };
  });

  app.post('/api/sessions/:id/pin', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
    const body = decodeRouteBody(SessionPinBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.pinned !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'pinned must be boolean' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'session.pin',
      body: { sessionId: id, pinned: body.pinned },
      fn: async (client) => {
        if (body.pinned) {
          await client.query(
            `INSERT INTO session_pins (user_id, session_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, session_id) DO NOTHING`,
            [user.id, id],
          );
        } else {
          await client.query('DELETE FROM session_pins WHERE user_id = $1 AND session_id = $2', [user.id, id]);
        }
        return { pinned: body.pinned as boolean };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'session-pinned', sessionId: id, pinned: response.pinned });
      },
    });
  });

  app.get('/api/sessions/:id/profile-change-proposals', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
    return { proposals: await agentProfiles.listSessionProposals(id, user.id) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/discard', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = decodeRouteParams(ProfileProposalParamsSchema, req.params);
    return { proposal: await agentProfiles.discardProposal(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/apply-lineage', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = decodeRouteParams(ProfileProposalParamsSchema, req.params);
    return { proposal: await agentProfiles.applyProposalToLineage(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-current-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = decodeRouteParams(ProfileProposalParamsSchema, req.params);
    const body = decodeRouteBody(SaveAgentProfileProposalToCurrentBodySchema, req.body);
    return await agentProfiles.saveProposalToCurrentProfile(user.id, id, proposalId, {
      ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    });
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-new-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = decodeRouteParams(ProfileProposalParamsSchema, req.params);
    const body = decodeRouteBody(SaveAgentProfileProposalAsNewBodySchema, req.body);
    const name = typeof body.name === 'string' ? body.name : '';
    return await agentProfiles.saveProposalToNewProfile(user.id, id, proposalId, name);
  });

  app.get('/api/sessions/:id/record', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
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
    const { id } = decodeRouteParams(SessionParamsSchema, req.params);
    const body = decodeRouteBody(PublishAppBodySchema, req.body);
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
    const { appId } = decodeRouteParams(AppLaunchParamsSchema, req.params);
    const body = decodeRouteBody(AppLaunchBodySchema, req.body);
    const version = body.version == null ? undefined : Number(body.version);
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
      return reply.code(400).send({ error: 'bad_request', message: 'version must be a positive integer' });
    }
    return reply.send(await appRegistry.launch(appId, user.id, version));
  });
}

function normalizeSessionRepos(repos: unknown): unknown[] | undefined {
  if (!Array.isArray(repos)) return undefined;
  return repos.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    if (typeof record.repo !== 'string') return entry;
    const repo = record.repo.trim();
    return { ...record, repo: normalizeGitHubRepoInput(repo) ?? repo };
  });
}

function privateGitHubRepos(reposInput: unknown): string[] {
  if (!Array.isArray(reposInput)) return [];
  const repos = new Set<string>();
  for (const repo of reposInput) {
    if (!repo || typeof repo !== 'object') continue;
    const record = repo as Record<string, unknown>;
    if (record.private !== true || typeof record.repo !== 'string') continue;
    const normalized = record.repo.trim();
    if (normalized) repos.add(normalized);
  }
  return [...repos];
}

function normalizeGitHubRepoInput(repo: string): string | null {
  let raw = repo.trim();
  raw = raw.replace(/\.git$/i, '');
  raw = raw.replace(/^ssh:\/\/git@github\.com[:/]/i, '');
  raw = raw.replace(/^git@github\.com:/i, '');
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    raw = url.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  }
  const parts = raw.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
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
  return row
    ? { ...row, connection_id: githubConnectionId({ tokenKind: row.token_kind, metadata: row.metadata }) }
    : null;
}

async function selectGitHubIdentityForSpawn(args: {
  connections: Connections;
  ironControl: IronControlAdminClient;
  pool: Db;
  userId: string;
  channelId: string;
  identityId: string;
}): Promise<
  | {
      ok: true;
      connection: {
        connection_id: string;
        workspace_id: string;
        user_id: string;
        token_kind: string | null;
        metadata: unknown;
      };
    }
  | { ok: false; status: number; error: string; message: string }
> {
  const workspaceId = await workspaceIdForChannel(args.pool, args.channelId);
  if (!workspaceId) {
    return { ok: false, status: 404, error: 'channel_not_found', message: 'channel not found' };
  }
  const [current] = await args.connections.list(args.userId, workspaceId);
  const identity = current?.identities.find((item) => item.id === args.identityId);
  if (!identity) {
    return { ok: false, status: 404, error: 'github_identity_not_found', message: 'GitHub identity not found' };
  }
  const staticSecretId = metadataString(identity.metadata, 'staticSecretId');
  if (!staticSecretId) {
    return {
      ok: false,
      status: 409,
      error: 'github_identity_reconnect_required',
      message: 'Reconnect this GitHub identity before using it for a session.',
    };
  }
  await convergeGitHubExistingIdentityGrant(args.ironControl, {
    workspaceId,
    userId: args.userId,
    staticSecretId,
    staleStaticSecretIds: await args.connections.gitHubIdentityStaticSecretIds(
      workspaceId,
      args.userId,
      args.identityId,
    ),
  });
  const activated = await args.connections.activateGitHubIdentity(workspaceId, args.userId, args.identityId);
  if (!activated) {
    return { ok: false, status: 404, error: 'github_identity_not_found', message: 'GitHub identity not found' };
  }
  return {
    ok: true,
    connection: {
      connection_id: activated.id,
      workspace_id: activated.workspaceId,
      user_id: args.userId,
      token_kind: activated.tokenKind,
      metadata: activated.metadata,
    },
  };
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
