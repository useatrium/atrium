import {
  CreateAgentProfileBodySchema,
  CreateAgentProfileVersionBodySchema,
  ImportLocalAgentProfileBodySchema,
} from '@atrium/surface-client/agentProfiles';
import { normalizePrefs, normalizePrefsPatch } from '@atrium/surface-client/prefs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import { githubConnectionAuditMetadata } from '../connection-audit.js';
import type { AppMutationContext } from '../app-mutations.js';
import { config } from '../config.js';
import type { Connections, ConnectionStatusJson } from '../connections.js';
import type { Db } from '../db.js';
import { exchangeClaudeCode, startClaudeOauth } from '../claude-oauth.js';
import { pollCodexDevice, startCodexDevice } from '../codex-oauth.js';
import type { UserRef } from '../events.js';
import {
  GitHubRepoValidationError,
  verifyGitHubAppInstallation,
  type GitHubAppInstallationInfo,
} from '../github-repo-validation.js';
import type { WsHub } from '../hub.js';
import {
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  githubAppUserBrokerCredentialForeignId,
} from '../iron-control.js';
import {
  GitHubAppInstallationUnconfiguredError,
  convergeGitHubExistingIdentityGrant,
  convergeGitHubBrokerGrant,
  convergeGitHubPatGrant,
  convergeGitHubPublicReadFallback,
  upsertGitHubInstallationBrokerCredential,
} from '../github-iron-control.js';
import { type AgentProfiles, providerFromProfileValue } from '../agent-profiles.js';
import { CODEX_PROVIDER, type ProviderCredentials } from '../provider-credentials.js';
import { PendingOAuthStore } from '../provider-oauth.js';
import type { SessionRuns } from '../session-runs.js';
import { decodeRouteBody, decodeRouteParams, decodeRouteQuery } from '../route-schema.js';

export interface MeRouteDeps extends AppMutationContext {
  hub: WsHub;
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  connections: Connections;
  ironControl: IronControlAdminClient;
  providerCredentials: ProviderCredentials;
  agentProfiles: AgentProfiles;
  sessionRuns: Pick<SessionRuns, 'clearClaudeAuthRequired' | 'clearProviderAuthRequired'>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function withoutOpId(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.opId;
  return rest;
}

const WorkspaceQuerySchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.String),
});

const GitHubConnectionBodySchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.Unknown),
  tokenKind: Schema.optional(Schema.Unknown),
  accountLogin: Schema.optional(Schema.Unknown),
  accountLabel: Schema.optional(Schema.Unknown),
  scopes: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
  capabilities: Schema.optional(Schema.Unknown),
  token: Schema.optional(Schema.Unknown),
  brokerCredentialId: Schema.optional(Schema.Unknown),
  installationId: Schema.optional(Schema.Unknown),
});

const GitHubActiveBodySchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.Unknown),
  identityId: Schema.optional(Schema.Unknown),
});

const GitHubCallbackQuerySchema = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  error_description: Schema.optional(Schema.Unknown),
});

const ByoWorkspaceBodySchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.Unknown),
});

const ClaudeOAuthExchangeBodySchema = Schema.Struct({
  pendingId: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.Unknown),
});

const CodexDevicePollBodySchema = Schema.Struct({
  pendingId: Schema.optional(Schema.Unknown),
});

const ClaudeTokenBodySchema = Schema.Struct({
  token: Schema.optional(Schema.Unknown),
});

const CodexAuthJsonBodySchema = Schema.Struct({
  authJson: Schema.optional(Schema.Unknown),
});

const AgentProfileParamsSchema = Schema.Struct({
  id: Schema.String,
});

const RecordBodySchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const DraftParamsSchema = Schema.Struct({
  draftKey: Schema.String,
});

const DraftBodySchema = Schema.Struct({
  text: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const {
    hub,
    pool,
    requireUser,
    optionalOpId,
    connections,
    ironControl,
    providerCredentials,
    agentProfiles,
    sessionRuns,
    runMutation,
  } = deps;

  app.get('/api/me/provider-credentials', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { providers: await providerCredentials.list(user.id) };
  });

  app.get('/api/me/connections', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const query = decodeRouteQuery(WorkspaceQuerySchema, req.query);
    const workspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : undefined;
    const resolvedWorkspaceId = await connections.resolveWorkspaceId(user.id, workspaceId);
    if (!resolvedWorkspaceId) {
      const error = workspaceId ? 'workspace_not_found' : 'no_workspace';
      return reply.code(workspaceId ? 404 : 403).send({ error, message: 'workspace not found' });
    }
    return { connections: await connections.list(user.id, resolvedWorkspaceId) };
  });

  app.post('/api/me/connections/github', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(GitHubConnectionBodySchema, req.body);
    const requestedWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
    const resolvedWorkspaceId = await connections.resolveWorkspaceId(user.id, requestedWorkspaceId);
    if (!resolvedWorkspaceId) {
      const error = requestedWorkspaceId ? 'workspace_not_found' : 'no_workspace';
      return reply.code(requestedWorkspaceId ? 404 : 403).send({ error, message: 'workspace not found' });
    }
    const tokenKind = normalizeGitHubTokenKind(body.tokenKind);
    if (!tokenKind) {
      if (!('tokenKind' in body)) {
        const [connection] = await connections.list(user.id, resolvedWorkspaceId);
        return { connection };
      }
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'tokenKind must be pat, app_installation, or app_user' });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    let brokerCredentialId = typeof body.brokerCredentialId === 'string' ? body.brokerCredentialId.trim() : '';
    let verifiedPatIdentity: { accountLogin: string; scopes: string[] } | null = null;
    let verifiedInstallation: GitHubAppInstallationInfo | null = null;
    const installationId =
      typeof body.installationId === 'string'
        ? body.installationId.trim()
        : typeof body.installationId === 'number' && Number.isSafeInteger(body.installationId)
          ? String(body.installationId)
          : '';
    if (tokenKind === 'app_user' && !brokerCredentialId && githubAppOAuthEnabled()) {
      const [connection] = await connections.list(user.id, resolvedWorkspaceId);
      return {
        connection,
        authorizeUrl: githubAppAuthorizeUrl({
          workspaceId: resolvedWorkspaceId,
          userId: user.id,
        }),
      };
    }
    let connection: ConnectionStatusJson;
    try {
      connection = await connections.withConnectionLock(resolvedWorkspaceId, user.id, 'github', async () => {
        if (!ironControl.configured) {
          throw new RouteResponse(503, 'iron_control_unconfigured', 'iron-control is not configured');
        }
        let staticSecret: { staticSecretId: string; staticSecretForeignId: string } | null = null;
        if (tokenKind === 'pat') {
          if (!token) {
            throw new RouteResponse(400, 'bad_request', 'GitHub token required');
          }
          verifiedPatIdentity = await validateGitHubPatToken(token);
          staticSecret = await convergeGitHubPatGrant(ironControl, {
            workspaceId: resolvedWorkspaceId,
            userId: user.id,
            token,
            staleStaticSecretIds: await connections.gitHubIdentityStaticSecretIds(resolvedWorkspaceId, user.id),
          });
        } else {
          if (tokenKind === 'app_installation' && !brokerCredentialId && installationId) {
            verifiedInstallation = await verifyGitHubInstallationForConnect(installationId);
            brokerCredentialId = await upsertGitHubInstallationBrokerCredentialForConnect(ironControl, {
              workspaceId: resolvedWorkspaceId,
              installationId,
            });
          }
          if (!brokerCredentialId) {
            throw new RouteResponse(
              400,
              tokenKind === 'app_installation' ? 'github_installation_required' : 'bad_request',
              tokenKind === 'app_installation'
                ? 'GitHub installation id or broker credential required'
                : 'GitHub broker credential required',
            );
          }
          staticSecret = await convergeGitHubBrokerGrant(ironControl, {
            workspaceId: resolvedWorkspaceId,
            userId: user.id,
            tokenKind,
            brokerCredentialId,
            ...(installationId ? { installationId } : {}),
            staleStaticSecretIds: await connections.gitHubIdentityStaticSecretIds(resolvedWorkspaceId, user.id),
          });
        }
        return connections.upsertGitHubMetadata({
          workspaceId: resolvedWorkspaceId,
          userId: user.id,
          status: 'connected',
          tokenKind,
          accountLogin:
            verifiedPatIdentity?.accountLogin ?? verifiedInstallation?.accountLogin ?? stringOrNull(body.accountLogin),
          accountLabel:
            verifiedPatIdentity?.accountLogin ?? verifiedInstallation?.accountLogin ?? stringOrNull(body.accountLabel),
          scopes: verifiedPatIdentity?.scopes ?? stringArray(body.scopes),
          capabilities: plainObject(body.capabilities),
          metadata: {
            ...plainObject(body.metadata),
            ...(token ? { last4: token.slice(-4) } : {}),
            ...(brokerCredentialId ? { brokerCredentialId } : {}),
            ...(installationId ? { installationId } : {}),
            ...(staticSecret ? { staticSecretId: staticSecret.staticSecretId } : {}),
            ...(staticSecret ? { staticSecretForeignId: staticSecret.staticSecretForeignId } : {}),
            ...(verifiedInstallation?.accountType ? { installationAccountType: verifiedInstallation.accountType } : {}),
            ...(verifiedInstallation?.targetType ? { installationTargetType: verifiedInstallation.targetType } : {}),
          },
        });
      });
    } catch (err) {
      req.log.warn(
        githubConnectionAuditMetadata({
          action: 'connect',
          result: 'failure',
          workspaceId: resolvedWorkspaceId,
          actorUserId: user.id,
          credentialOwnerUserId: user.id,
          requestedTokenKind: body.tokenKind,
          error: err,
        }),
        'github connection convergence failed',
      );
      if (err instanceof RouteResponse) {
        return reply.code(err.statusCode).send({ error: err.error, message: err.message });
      }
      throw err;
    }
    req.log.info(
      githubConnectionAuditMetadata({
        action: 'connect',
        result: 'success',
        workspaceId: resolvedWorkspaceId,
        actorUserId: user.id,
        credentialOwnerUserId: user.id,
        requestedTokenKind: body.tokenKind,
        connection,
      }),
      'github connection converged',
    );
    return { connection };
  });

  app.post('/api/me/connections/github/active', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(GitHubActiveBodySchema, req.body);
    const requestedWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
    const resolvedWorkspaceId = await connections.resolveWorkspaceId(user.id, requestedWorkspaceId);
    if (!resolvedWorkspaceId) {
      const error = requestedWorkspaceId ? 'workspace_not_found' : 'no_workspace';
      return reply.code(requestedWorkspaceId ? 404 : 403).send({ error, message: 'workspace not found' });
    }
    const identityId = typeof body.identityId === 'string' ? body.identityId.trim() : '';
    if (!identityId) {
      return reply.code(400).send({ error: 'bad_request', message: 'identityId required' });
    }
    let connection: ConnectionStatusJson | null = null;
    try {
      connection = await connections.withConnectionLock(resolvedWorkspaceId, user.id, 'github', async () => {
        if (!ironControl.configured) {
          throw new RouteResponse(503, 'iron_control_unconfigured', 'iron-control is not configured');
        }
        const [current] = await connections.list(user.id, resolvedWorkspaceId);
        if (!current) {
          throw new RouteResponse(404, 'github_identity_not_found', 'GitHub identity not found');
        }
        const identity = current.identities.find((item) => item.id === identityId);
        if (!identity) {
          throw new RouteResponse(404, 'github_identity_not_found', 'GitHub identity not found');
        }
        const staticSecretId = metadataString(identity.metadata, 'staticSecretId');
        if (!staticSecretId) {
          throw new RouteResponse(
            409,
            'github_identity_reconnect_required',
            'This GitHub identity was saved before switchable identity secrets were tracked. Reconnect it before activating.',
          );
        }
        await convergeGitHubExistingIdentityGrant(ironControl, {
          workspaceId: resolvedWorkspaceId,
          userId: user.id,
          staticSecretId,
          staleStaticSecretIds: await connections.gitHubIdentityStaticSecretIds(
            resolvedWorkspaceId,
            user.id,
            identityId,
          ),
        });
        return connections.activateGitHubIdentity(resolvedWorkspaceId, user.id, identityId);
      });
    } catch (err) {
      if (err instanceof RouteResponse) {
        return reply.code(err.statusCode).send({ error: err.error, message: err.message });
      }
      throw err;
    }
    if (!connection) {
      return reply.code(404).send({ error: 'github_identity_not_found', message: 'GitHub identity not found' });
    }
    req.log.info(
      githubConnectionAuditMetadata({
        action: 'activate',
        result: 'success',
        workspaceId: resolvedWorkspaceId,
        actorUserId: user.id,
        credentialOwnerUserId: user.id,
        requestedTokenKind: connection.tokenKind,
        connection,
      }),
      'github connection identity activated',
    );
    return { connection };
  });

  app.get('/api/me/connections/github/callback', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!githubAppOAuthEnabled()) return reply.code(404).send({ error: 'not_found' });
    const query = decodeRouteQuery(GitHubCallbackQuerySchema, req.query);
    const error = typeof query.error === 'string' ? query.error : '';
    if (error) {
      const errorDescription = typeof query.error_description === 'string' ? query.error_description : undefined;
      return reply.code(400).send({ error: 'github_oauth_failed', message: errorDescription ?? error });
    }
    const state = verifyGitHubConnectionState(query.state);
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || !state || state.userId !== user.id) {
      return reply.code(400).send({ error: 'invalid_oauth_state' });
    }
    const workspaceId = await connections.resolveWorkspaceId(user.id, state.workspaceId);
    if (!workspaceId || workspaceId !== state.workspaceId) {
      return reply.code(404).send({ error: 'workspace_not_found', message: 'workspace not found' });
    }
    if (!ironControl.configured) {
      return reply.code(503).send({ error: 'iron_control_unconfigured', message: 'iron-control is not configured' });
    }

    let connection: ConnectionStatusJson;
    try {
      const token = await exchangeGitHubAppUserCode(code);
      if (!token.refreshToken) {
        return reply.code(400).send({
          error: 'github_refresh_token_missing',
          message: 'GitHub App user tokens must have expiring user tokens enabled',
        });
      }
      if (!token.accessToken) {
        return reply.code(400).send({
          error: 'github_oauth_exchange_failed',
          message: 'GitHub OAuth exchange returned no access token',
        });
      }
      const accountLogin = await fetchGitHubTokenLogin(token.accessToken);
      const brokerCredentialId = githubAppUserBrokerCredentialForeignId(workspaceId, user.id);
      await ironControl.upsertBrokerCredential({
        foreignId: brokerCredentialId,
        name: `GitHub App user token for ${atriumPrincipalForeignId(workspaceId, user.id)}`,
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        clientId: config.githubAppClientId,
        clientSecret: config.githubAppClientSecret,
        refreshToken: token.refreshToken,
        scopes: token.scopes,
        labels: {
          source: 'atrium',
          provider: 'github',
          token_kind: 'app_user',
          atrium_workspace_id: workspaceId,
          atrium_user_id: user.id,
        },
      });
      connection = await connections.withConnectionLock(workspaceId, user.id, 'github', async () => {
        const staticSecret = await convergeGitHubBrokerGrant(ironControl, {
          workspaceId,
          userId: user.id,
          tokenKind: 'app_user',
          brokerCredentialId,
          staleStaticSecretIds: await connections.gitHubIdentityStaticSecretIds(workspaceId, user.id),
        });
        return connections.upsertGitHubMetadata({
          workspaceId,
          userId: user.id,
          status: 'connected',
          tokenKind: 'app_user',
          accountLogin,
          accountLabel: accountLogin,
          scopes: token.scopes,
          capabilities: {},
          metadata: {
            brokerCredentialId,
            staticSecretId: staticSecret.staticSecretId,
            staticSecretForeignId: staticSecret.staticSecretForeignId,
          },
        });
      });
    } catch (err) {
      if (err instanceof RouteResponse) {
        return reply.code(err.statusCode).send({ error: err.error, message: err.message });
      }
      throw err;
    }
    req.log.info(
      githubConnectionAuditMetadata({
        action: 'connect',
        result: 'success',
        workspaceId,
        actorUserId: user.id,
        credentialOwnerUserId: user.id,
        requestedTokenKind: 'app_user',
        connection,
      }),
      'github app user connection converged',
    );
    return reply.redirect('/?githubConnection=connected', 302);
  });

  app.delete('/api/me/connections/github', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const query = decodeRouteQuery(WorkspaceQuerySchema, req.query);
    const workspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : undefined;
    const resolvedWorkspaceId = await connections.resolveWorkspaceId(user.id, workspaceId);
    if (!resolvedWorkspaceId) {
      const error = workspaceId ? 'workspace_not_found' : 'no_workspace';
      return reply.code(workspaceId ? 404 : 403).send({ error, message: 'workspace not found' });
    }
    let connection: ConnectionStatusJson;
    try {
      connection = await connections.withConnectionLock(resolvedWorkspaceId, user.id, 'github', async () => {
        if (ironControl.configured) {
          await convergeGitHubPublicReadFallback(ironControl, {
            workspaceId: resolvedWorkspaceId,
            userId: user.id,
          });
        }
        return connections.disconnectGitHub(resolvedWorkspaceId, user.id);
      });
    } catch (err) {
      req.log.warn(
        githubConnectionAuditMetadata({
          action: 'disconnect',
          result: 'failure',
          workspaceId: resolvedWorkspaceId,
          actorUserId: user.id,
          credentialOwnerUserId: user.id,
          error: err,
        }),
        'github connection disconnect failed',
      );
      throw err;
    }
    req.log.info(
      githubConnectionAuditMetadata({
        action: 'disconnect',
        result: 'success',
        workspaceId: resolvedWorkspaceId,
        actorUserId: user.id,
        credentialOwnerUserId: user.id,
        connection,
      }),
      'github connection disconnected',
    );
    return { connection };
  });

  // === byo subscription onboarding (token-never-in-box, injected by iron-proxy) ===
  const pendingOAuth = new PendingOAuthStore(pool);

  // Resolve the caller's workspace and confirm iron-control is available, sending
  // the appropriate error and returning null when either check fails.
  const resolveByoWorkspace = async (
    userId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> => {
    const body = decodeRouteBody(ByoWorkspaceBodySchema, req.body);
    const requested = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
    const workspaceId = await connections.resolveWorkspaceId(userId, requested);
    if (!workspaceId) {
      reply
        .code(requested ? 404 : 403)
        .send({ error: requested ? 'workspace_not_found' : 'no_workspace', message: 'workspace not found' });
      return null;
    }
    if (!ironControl.configured) {
      reply.code(503).send({ error: 'iron_control_unconfigured', message: 'iron-control is not configured' });
      return null;
    }
    return workspaceId;
  };

  app.post('/api/me/provider-credentials/claude-code/oauth/start', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const workspaceId = await resolveByoWorkspace(user.id, req, reply);
    if (!workspaceId) return;
    return startClaudeOauth({ pendingOAuth }, user.id);
  });

  app.post('/api/me/provider-credentials/claude-code/oauth/exchange', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const workspaceId = await resolveByoWorkspace(user.id, req, reply);
    if (!workspaceId) return;
    const body = decodeRouteBody(ClaudeOAuthExchangeBodySchema, req.body);
    const pendingId = typeof body.pendingId === 'string' ? body.pendingId.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!pendingId || !code) {
      return reply.code(400).send({ error: 'bad_request', message: 'pendingId and code required' });
    }
    const result = await exchangeClaudeCode({ pendingOAuth, ironControl }, user.id, workspaceId, pendingId, code);
    if (result.status === 'connected') {
      await providerCredentials.markConnectedViaProxy(user.id, 'claude-code');
      await sessionRuns.clearProviderAuthRequired(user.id, 'claude-code');
    }
    return result;
  });

  app.post('/api/me/provider-credentials/codex/device/start', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const workspaceId = await resolveByoWorkspace(user.id, req, reply);
    if (!workspaceId) return;
    return startCodexDevice({ pendingOAuth }, user.id);
  });

  app.post('/api/me/provider-credentials/codex/device/poll', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const workspaceId = await resolveByoWorkspace(user.id, req, reply);
    if (!workspaceId) return;
    const body = decodeRouteBody(CodexDevicePollBodySchema, req.body);
    const pendingId = typeof body.pendingId === 'string' ? body.pendingId.trim() : '';
    if (!pendingId) return reply.code(400).send({ error: 'bad_request', message: 'pendingId required' });
    const result = await pollCodexDevice({ pendingOAuth, ironControl }, user.id, workspaceId, pendingId);
    if (result.status === 'connected') {
      await providerCredentials.markConnectedViaProxy(user.id, 'codex');
      await sessionRuns.clearProviderAuthRequired(user.id, 'codex');
    }
    return result;
  });

  app.put('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(ClaudeTokenBodySchema, req.body);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      return reply.code(400).send({ error: 'bad_request', message: 'Claude token required' });
    }
    try {
      const provider = await providerCredentials.upsertClaudeToken(user.id, token);
      await sessionRuns.clearClaudeAuthRequired(user.id);
      return { provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid Claude token';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.put('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(CodexAuthJsonBodySchema, req.body);
    const authJson = typeof body.authJson === 'string' ? body.authJson.trim() : '';
    if (!authJson) {
      return reply.code(400).send({ error: 'bad_request', message: 'Codex auth.json required' });
    }
    try {
      const provider = await providerCredentials.upsertCodexAuthJson(user.id, authJson);
      await sessionRuns.clearProviderAuthRequired(user.id, CODEX_PROVIDER);
      return { provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid Codex auth.json';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.delete('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteClaudeToken(user.id);
    return { ok: true };
  });

  app.delete('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteCodexAuthJson(user.id);
    return { ok: true };
  });

  app.get('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { profiles: await agentProfiles.listProfiles(user.id) };
  });

  app.post('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(CreateAgentProfileBodySchema, req.body);
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    return { profile: await agentProfiles.createProfile(user.id, provider, name) };
  });

  app.get('/api/me/agent-profiles/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(AgentProfileParamsSchema, req.params);
    return { profile: await agentProfiles.getProfile(user.id, id) };
  });

  app.post('/api/me/agent-profiles/:id/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = decodeRouteParams(AgentProfileParamsSchema, req.params);
    const body = decodeRouteBody(CreateAgentProfileVersionBodySchema, req.body);
    return { version: await agentProfiles.createVersion(user.id, id, body) };
  });

  app.post('/api/me/agent-profiles/import-local', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(ImportLocalAgentProfileBodySchema, req.body);
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    return { proposal: await agentProfiles.createImportProposal(user.id, provider, body.proposal ?? body) };
  });

  app.patch('/api/me/prefs', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const prefsBody = decodeRouteBody(RecordBodySchema, req.body);
    const opId = optionalOpId(prefsBody);
    return runMutation({
      userId: user.id,
      opId,
      opType: 'prefs.patch',
      body: withoutOpId(prefsBody),
      fn: async (client) => {
        const current = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [user.id]);
        const merged = normalizePrefs({
          ...normalizePrefs(current.rows[0]?.prefs),
          ...normalizePrefsPatch(prefsBody),
        });
        await client.query('UPDATE users SET prefs = $1 WHERE id = $2', [JSON.stringify(merged), user.id]);
        return { prefs: merged };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'prefs', prefs: response.prefs });
      },
    });
  });

  app.put('/api/me/drafts/:draftKey', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const { draftKey } = decodeRouteParams(DraftParamsSchema, req.params);
    const body = decodeRouteBody(DraftBodySchema, req.body);
    const opId = optionalOpId(body);
    if (typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'text is required' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'draft.set',
      body: { draftKey, text: body.text },
      fn: async (client) => {
        if (body.text === '') {
          await client.query(
            `UPDATE user_drafts
             SET text = '', deleted_at = now(), updated_at = now()
             WHERE user_id = $1 AND draft_key = $2`,
            [user.id, draftKey],
          );
          return { ok: true as const };
        }
        await client.query(
          `INSERT INTO user_drafts (user_id, draft_key, text, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, draft_key)
           DO UPDATE SET text = EXCLUDED.text, updated_at = now(), deleted_at = NULL`,
          [user.id, draftKey, body.text],
        );
        return { ok: true as const };
      },
    });
  });
}

function normalizeGitHubTokenKind(value: unknown): 'pat' | 'app_installation' | 'app_user' | null {
  if (value === 'pat' || value === 'app_installation' || value === 'app_user') return value;
  return null;
}

type GitHubConnectionState = {
  workspaceId: string;
  userId: string;
  exp: number;
};

type GitHubAppUserToken = {
  accessToken: string | null;
  refreshToken: string | null;
  scopes: string[];
};

function githubAppOAuthEnabled(): boolean {
  return Boolean(config.githubAppClientId && config.githubAppClientSecret && config.githubAppRedirectUrl);
}

function githubAppAuthorizeUrl(args: { workspaceId: string; userId: string }): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubAppClientId);
  url.searchParams.set('redirect_uri', config.githubAppRedirectUrl);
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set(
    'state',
    signGitHubConnectionState({
      workspaceId: args.workspaceId,
      userId: args.userId,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  return url.toString();
}

function signGitHubConnectionState(state: GitHubConnectionState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = createHmac('sha256', config.appSigningSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyGitHubConnectionState(value: unknown): GitHubConnectionState | null {
  if (typeof value !== 'string') return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', config.appSigningSecret).update(payload).digest('base64url');
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<GitHubConnectionState>;
    if (
      typeof decoded.workspaceId !== 'string' ||
      typeof decoded.userId !== 'string' ||
      typeof decoded.exp !== 'number' ||
      decoded.exp * 1000 <= Date.now()
    ) {
      return null;
    }
    return { workspaceId: decoded.workspaceId, userId: decoded.userId, exp: decoded.exp };
  } catch {
    return null;
  }
}

async function exchangeGitHubAppUserCode(code: string): Promise<GitHubAppUserToken> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.githubAppClientId,
      client_secret: config.githubAppClientSecret,
      code,
      redirect_uri: config.githubAppRedirectUrl,
    }),
  });
  if (!res.ok) {
    throw new RouteResponse(400, 'github_oauth_exchange_failed', 'GitHub OAuth exchange failed');
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.error === 'string') {
    throw new RouteResponse(400, 'github_oauth_exchange_failed', stringOrNull(body.error_description) ?? body.error);
  }
  return {
    accessToken: stringOrNull(body.access_token),
    refreshToken: stringOrNull(body.refresh_token),
    scopes: typeof body.scope === 'string' ? stringArray(body.scope.split(',')) : [],
  };
}

async function fetchGitHubTokenLogin(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new RouteResponse(502, 'github_user_lookup_failed', 'Could not fetch GitHub user identity');
  }
  const body = (await res.json().catch(() => null)) as { login?: unknown } | null;
  const login = stringOrNull(body?.login);
  if (!login) {
    throw new RouteResponse(502, 'github_user_lookup_failed', 'GitHub user lookup returned no login');
  }
  return login;
}

async function validateGitHubPatToken(token: string): Promise<{ accountLogin: string; scopes: string[] }> {
  const res = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new RouteResponse(401, 'github_token_invalid', 'GitHub token is invalid or unauthorized');
  }
  if (!res.ok) {
    throw new RouteResponse(502, 'github_token_validation_failed', 'Could not validate GitHub token');
  }
  const body = (await res.json().catch(() => null)) as { login?: unknown } | null;
  const accountLogin = stringOrNull(body?.login);
  if (!accountLogin) {
    throw new RouteResponse(502, 'github_token_validation_failed', 'GitHub token validation returned no login');
  }
  return {
    accountLogin,
    scopes: scopesHeaderArray(res.headers.get('x-oauth-scopes')),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function scopesHeaderArray(value: string | null): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function plainObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

class RouteResponse extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

async function upsertGitHubInstallationBrokerCredentialForConnect(
  ironControl: IronControlAdminClient,
  args: {
    workspaceId: string;
    installationId: string;
  },
): Promise<string> {
  try {
    return await upsertGitHubInstallationBrokerCredential(ironControl, args);
  } catch (err) {
    if (err instanceof GitHubAppInstallationUnconfiguredError) {
      throw new RouteResponse(
        503,
        'github_app_installation_unconfigured',
        'GitHub App installation credentials are not configured',
      );
    }
    throw err;
  }
}

async function verifyGitHubInstallationForConnect(installationId: string): Promise<GitHubAppInstallationInfo> {
  try {
    return await verifyGitHubAppInstallation({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      privateKeyId: config.githubAppPrivateKeyId || undefined,
      installationId,
    });
  } catch (err) {
    if (err instanceof GitHubRepoValidationError && err.code === 'unconfigured') {
      throw new RouteResponse(
        503,
        'github_app_installation_unconfigured',
        'GitHub App installation credentials are not configured',
      );
    }
    throw new RouteResponse(400, 'github_installation_unverified', 'Could not verify GitHub installation id');
  }
}
