import {
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  githubPatSecretForeignId,
} from './iron-control.js';

export async function convergeGitHubPatGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; token: string },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  const secret = await ironControl.upsertGitHubPatSecret({
    foreignId: githubPatSecretForeignId(args.workspaceId, args.userId),
    name: `GitHub token for ${foreignId}`,
    token: args.token,
    labels: {
      source: 'atrium',
      provider: 'github',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });
  const grants = await ironControl.listPrincipalGrants(principal.id);
  if (!grants.some((grant) => grant.static_secret_id === secret.id)) {
    await ironControl.createPrincipalStaticGrant(principal.id, secret.id);
  }
  const defaultRole = await upsertGitHubDefaultRole(ironControl);
  await ironControl.unassignRole(principal.id, defaultRole.id).catch(() => {});
  await ironControl.verifySingleGitHubTokenTransform(foreignId);
}

export async function convergeGitHubBrokerGrant(
  ironControl: IronControlAdminClient,
  args: {
    workspaceId: string;
    userId: string;
    tokenKind: 'app_installation' | 'app_user';
    brokerCredentialId: string;
  },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  const secret = await ironControl.upsertGitHubBrokerSecret({
    foreignId: githubPatSecretForeignId(args.workspaceId, args.userId),
    name: `GitHub ${args.tokenKind} token for ${foreignId}`,
    brokerCredentialId: args.brokerCredentialId,
    labels: {
      source: 'atrium',
      provider: 'github',
      token_kind: args.tokenKind,
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });
  const grants = await ironControl.listPrincipalGrants(principal.id);
  if (!grants.some((grant) => grant.static_secret_id === secret.id)) {
    await ironControl.createPrincipalStaticGrant(principal.id, secret.id);
  }
  const defaultRole = await upsertGitHubDefaultRole(ironControl);
  await ironControl.unassignRole(principal.id, defaultRole.id).catch(() => {});
  await ironControl.verifySingleGitHubTokenTransform(foreignId);
}

export async function convergeGitHubPublicReadFallback(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  await ironControl.deleteStaticSecret(githubPatSecretForeignId(args.workspaceId, args.userId)).catch(() => {});
  const defaultRole = await upsertGitHubDefaultRole(ironControl);
  await ironControl.assignRole(principal.id, defaultRole.id);
  await ironControl.verifySingleGitHubTokenTransform(foreignId);
}

async function upsertAtriumGitHubPrincipal(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string },
) {
  return ironControl.upsertPrincipal({
    foreignId: atriumPrincipalForeignId(args.workspaceId, args.userId),
    name: `Atrium Workspace ${args.workspaceId} User ${args.userId}`,
    labels: {
      source: 'atrium',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });
}

function upsertGitHubDefaultRole(ironControl: IronControlAdminClient) {
  return ironControl.upsertRole({
    foreignId: 'github-default',
    name: 'GitHub public-read fallback',
    labels: { source: 'atrium', provider: 'github', kind: 'fallback' },
  });
}
