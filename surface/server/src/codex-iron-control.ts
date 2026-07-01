import { config } from './config.js';
import {
  IronControlRequestError,
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  codexAccountIdSecretForeignId,
  codexBearerSecretForeignId,
  codexBrokerCredentialForeignId,
} from './iron-control.js';

export async function convergeCodexBrokerGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; refreshToken: string; accountId: string },
): Promise<void> {
  const { workspaceId, userId, refreshToken, accountId } = args;
  const foreignId = atriumPrincipalForeignId(workspaceId, userId);
  const labels = {
    source: 'atrium',
    provider: 'codex',
    atrium_workspace_id: workspaceId,
    atrium_user_id: userId,
  };

  const principal = await ironControl.upsertPrincipal({
    foreignId,
    name: `Atrium Workspace ${workspaceId} User ${userId}`,
    labels: {
      source: 'atrium',
      atrium_workspace_id: workspaceId,
      atrium_user_id: userId,
    },
  });

  const infra = await ironControl.lookupRole('infra');
  try {
    await ironControl.assignRole(principal.id, infra.id);
  } catch (err) {
    if (!(err instanceof IronControlRequestError && (err.status === 409 || err.status === 422))) {
      throw err;
    }
  }

  const broker = await ironControl.upsertBrokerCredential({
    foreignId: codexBrokerCredentialForeignId(workspaceId, userId),
    name: `Codex sub for ${foreignId}`,
    tokenEndpoint: `${config.codexOauthIssuer}/oauth/token`,
    clientId: config.codexOauthClientId,
    refreshToken,
    scopes: [],
    labels,
  });

  const bearer = await ironControl.upsertInjectSecret({
    foreignId: codexBearerSecretForeignId(workspaceId, userId),
    name: `Codex bearer ${foreignId}`,
    header: 'Authorization',
    formatter: 'Bearer {{.Value}}',
    host: 'chatgpt.com',
    source: { kind: 'token_broker', brokerCredentialId: broker.id },
    labels,
  });

  const account = await ironControl.upsertInjectSecret({
    foreignId: codexAccountIdSecretForeignId(workspaceId, userId),
    name: `Codex account ${foreignId}`,
    header: 'ChatGPT-Account-ID',
    host: 'chatgpt.com',
    source: { kind: 'control_plane', secret: accountId },
    labels,
  });

  const grants = await ironControl.listPrincipalGrants(principal.id);
  for (const secret of [bearer, account]) {
    if (!grants.some((grant) => grant.static_secret_id === secret.id)) {
      await ironControl.createPrincipalStaticGrant(principal.id, secret.id);
    }
  }
}
