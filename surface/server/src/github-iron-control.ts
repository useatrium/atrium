import {
  IronControlRequestError,
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  githubAppFallbackBrokerCredentialForeignId,
  githubAppFallbackSecretForeignId,
  githubAppInstallationBrokerCredentialForeignId,
  githubConnectionSecretForeignId,
  githubPatSecretForeignId,
} from './iron-control.js';
import { config } from './config.js';
import { githubConnectionId } from './connections.js';
import { listGitHubAppInstallations } from './github-repo-validation.js';

export async function convergeGitHubPatGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; token: string; staleStaticSecretIds?: readonly string[] },
): Promise<{ staticSecretId: string; staticSecretForeignId: string }> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  const staticSecretForeignId = githubConnectionSecretForeignId(
    args.workspaceId,
    args.userId,
    githubConnectionId({ tokenKind: 'pat' }),
  );
  const secret = await ironControl.upsertGitHubPatSecret({
    foreignId: staticSecretForeignId,
    name: `GitHub token for ${foreignId}`,
    token: args.token,
    labels: {
      source: 'atrium',
      provider: 'github',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });
  await convergeGitHubDirectGrant(ironControl, {
    principalId: principal.id,
    staticSecretId: secret.id,
    foreignId,
    staleStaticSecretIds: args.staleStaticSecretIds,
  });
  return { staticSecretId: secret.id, staticSecretForeignId };
}

export async function convergeGitHubBrokerGrant(
  ironControl: IronControlAdminClient,
  args: {
    workspaceId: string;
    userId: string;
    tokenKind: 'app_installation' | 'app_user';
    brokerCredentialId: string;
    installationId?: string;
    staleStaticSecretIds?: readonly string[];
  },
): Promise<{ staticSecretId: string; staticSecretForeignId: string }> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  const staticSecretForeignId = githubConnectionSecretForeignId(
    args.workspaceId,
    args.userId,
    githubConnectionId({
      tokenKind: args.tokenKind,
      metadata: args.installationId ? { installationId: args.installationId } : {},
    }),
  );
  const secret = await ironControl.upsertGitHubBrokerSecret({
    foreignId: staticSecretForeignId,
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
  await convergeGitHubDirectGrant(ironControl, {
    principalId: principal.id,
    staticSecretId: secret.id,
    foreignId,
    staleStaticSecretIds: args.staleStaticSecretIds,
  });
  return { staticSecretId: secret.id, staticSecretForeignId };
}

export async function convergeGitHubExistingIdentityGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; staticSecretId: string; staleStaticSecretIds?: readonly string[] },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  await convergeGitHubDirectGrant(ironControl, {
    principalId: principal.id,
    staticSecretId: args.staticSecretId,
    foreignId,
    staleStaticSecretIds: args.staleStaticSecretIds,
  });
}

export async function convergeExistingGitHubDirectGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  const defaultRole = await convergeGitHubPublicReadRole(ironControl);
  await ironControl.unassignRole(principal.id, defaultRole.id).catch(() => {});
  await ironControl.verifySingleGitHubTokenTransform(foreignId);
}

async function convergeGitHubDirectGrant(
  ironControl: IronControlAdminClient,
  args: {
    principalId: string;
    staticSecretId: string;
    foreignId: string;
    staleStaticSecretIds?: readonly string[];
  },
): Promise<void> {
  const grants = await ironControl.listPrincipalGrants(args.principalId);
  const stale = new Set((args.staleStaticSecretIds ?? []).filter((id) => id && id !== args.staticSecretId));
  for (const grant of grants) {
    if (grant.id && grant.static_secret_id && stale.has(grant.static_secret_id)) {
      await ironControl.deleteGrant(grant.id);
    }
  }
  if (!grants.some((grant) => grant.static_secret_id === args.staticSecretId)) {
    await ironControl.createPrincipalStaticGrant(args.principalId, args.staticSecretId);
  }
  const defaultRole = await convergeGitHubPublicReadRole(ironControl);
  await ironControl.unassignRole(args.principalId, defaultRole.id).catch(() => {});
  await ironControl.verifySingleGitHubTokenTransform(args.foreignId);
}

export async function convergeGitHubPublicReadFallback(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await upsertAtriumGitHubPrincipal(ironControl, args);
  await ironControl.deleteStaticSecret(githubPatSecretForeignId(args.workspaceId, args.userId)).catch(() => {});
  const defaultRole = await convergeGitHubPublicReadRole(ironControl);
  await ironControl.assignRole(principal.id, defaultRole.id);
  await ironControl.verifySingleGitHubTokenTransform(foreignId);
}

async function upsertAtriumGitHubPrincipal(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string },
) {
  const principal = await ironControl.upsertPrincipal({
    foreignId: atriumPrincipalForeignId(args.workspaceId, args.userId),
    name: `Atrium Workspace ${args.workspaceId} User ${args.userId}`,
    labels: {
      source: 'atrium',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });
  await assignInfraRole(ironControl, principal.id);
  return principal;
}

async function assignInfraRole(ironControl: IronControlAdminClient, principalId: string): Promise<void> {
  const role = await ironControl.lookupRole('infra');
  await ironControl.assignRole(principalId, role.id).catch((err: unknown) => {
    if (err instanceof IronControlRequestError && (err.status === 409 || err.status === 422)) return;
    throw err;
  });
}

export class GitHubAppInstallationUnconfiguredError extends Error {
  constructor() {
    super('GitHub App installation credentials are not configured');
  }
}

function githubAppConfigured(): boolean {
  return Boolean(config.githubAppId && config.githubAppPrivateKey);
}

export async function upsertGitHubInstallationBrokerCredential(
  ironControl: IronControlAdminClient,
  args: {
    workspaceId: string;
    installationId: string;
  },
): Promise<string> {
  if (!githubAppConfigured()) {
    throw new GitHubAppInstallationUnconfiguredError();
  }
  return upsertGitHubAppInstallationCredential(ironControl, {
    foreignId: githubAppInstallationBrokerCredentialForeignId(args.workspaceId, args.installationId),
    name: `GitHub App installation ${args.installationId} for workspace ${args.workspaceId}`,
    installationId: args.installationId,
    labels: { atrium_workspace_id: args.workspaceId },
  });
}

async function upsertGitHubAppInstallationCredential(
  ironControl: IronControlAdminClient,
  args: {
    foreignId: string;
    name: string;
    installationId: string;
    labels: Record<string, string>;
  },
): Promise<string> {
  await ironControl.upsertGitHubAppInstallationBrokerCredential({
    foreignId: args.foreignId,
    name: args.name,
    githubAppId: config.githubAppId,
    githubInstallationId: args.installationId,
    githubPrivateKey: config.githubAppPrivateKey,
    githubPrivateKeyId: config.githubAppPrivateKeyId || undefined,
    labels: {
      source: 'atrium',
      provider: 'github',
      token_kind: 'app_installation',
      ...args.labels,
      github_installation_id: args.installationId,
    },
  });
  return args.foreignId;
}

export async function convergeGitHubPublicReadRole(
  ironControl: IronControlAdminClient,
  publicReadToken = config.githubPublicReadToken,
  listInstallations: typeof listGitHubAppInstallations = listGitHubAppInstallations,
) {
  const role = await ironControl.upsertRole({
    foreignId: 'github-default',
    name: 'GitHub public-read fallback',
    labels: { source: 'atrium', provider: 'github', kind: 'fallback' },
  });

  if (githubAppConfigured()) {
    const installationId = await resolveGitHubAppFallbackInstallationId(listInstallations);
    if (installationId) {
      const brokerCredentialId = await upsertGitHubAppInstallationCredential(ironControl, {
        foreignId: githubAppFallbackBrokerCredentialForeignId(installationId),
        name: `GitHub App installation ${installationId} fallback for unconnected users`,
        installationId,
        labels: { kind: 'fallback' },
      });
      const secret = await ironControl.upsertGitHubBrokerSecret({
        foreignId: githubAppFallbackSecretForeignId(),
        name: 'GitHub App installation fallback token',
        brokerCredentialId,
        labels: { source: 'atrium', provider: 'github', kind: 'fallback', token_kind: 'app_installation' },
      });
      await convergeGitHubRoleSecretGrant(ironControl, role.id, secret.id);
      return role;
    }
  }

  if (!publicReadToken) return role;

  const secret = await ironControl.upsertGitHubPublicReadSecret({
    token: publicReadToken,
    labels: { source: 'atrium', provider: 'github', token_kind: 'public_read' },
  });
  await convergeGitHubRoleSecretGrant(ironControl, role.id, secret.id);
  return role;
}

async function resolveGitHubAppFallbackInstallationId(
  listInstallations: typeof listGitHubAppInstallations,
): Promise<string | null> {
  const explicit = config.githubAppFallbackInstallationId.trim();
  if (explicit) return explicit;
  let installations: Awaited<ReturnType<typeof listGitHubAppInstallations>>;
  try {
    installations = await listInstallations({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      privateKeyId: config.githubAppPrivateKeyId || undefined,
    });
  } catch (err) {
    console.warn('GitHub App fallback installation discovery failed; using the static public-read fallback', { err });
    return null;
  }
  if (installations.length === 1) return installations[0]!.installationId;
  console.warn(
    `GitHub App fallback expects exactly one installation but found ${installations.length}; ` +
      'set GITHUB_APP_FALLBACK_INSTALLATION_ID to pick one. Using the static public-read fallback.',
  );
  return null;
}

// Converges the role to exactly one GitHub token grant: stale grants pointing
// at a different secret (e.g. after switching between the static public-read
// token and the App-backed broker secret) are removed, mirroring
// convergeGitHubDirectGrant's stale cleanup for principals.
async function convergeGitHubRoleSecretGrant(
  ironControl: IronControlAdminClient,
  roleId: string,
  staticSecretId: string,
): Promise<void> {
  const grants = await ironControl.listRoleGrants(roleId);
  for (const grant of grants) {
    if (grant.id && grant.static_secret_id && grant.static_secret_id !== staticSecretId) {
      await ironControl.deleteGrant(grant.id);
    }
  }
  if (!grants.some((grant) => grant.static_secret_id === staticSecretId)) {
    await ironControl.createRoleStaticGrant(roleId, staticSecretId);
  }
}
