import {
  IronControlRequestError,
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  claudeStaticSecretForeignId,
} from './iron-control.js';

export async function convergeClaudeStaticGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; token: string },
): Promise<void> {
  const foreignId = atriumPrincipalForeignId(args.workspaceId, args.userId);
  const principal = await ironControl.upsertPrincipal({
    foreignId,
    name: `Atrium Workspace ${args.workspaceId} User ${args.userId}`,
    labels: {
      source: 'atrium',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });

  const infra = await ironControl.lookupRole('infra');
  await ironControl.assignRole(principal.id, infra.id).catch((err: unknown) => {
    if (err instanceof IronControlRequestError && (err.status === 409 || err.status === 422)) return;
    throw err;
  });

  const secret = await ironControl.upsertInjectSecret({
    foreignId: claudeStaticSecretForeignId(args.workspaceId, args.userId),
    name: `Claude sub for ${foreignId}`,
    header: 'Authorization',
    formatter: 'Bearer {{.Value}}',
    host: 'api.anthropic.com',
    source: { kind: 'control_plane', secret: args.token },
    labels: {
      source: 'atrium',
      provider: 'claude-code',
      atrium_workspace_id: args.workspaceId,
      atrium_user_id: args.userId,
    },
  });

  const grants = await ironControl.listPrincipalGrants(principal.id);
  if (!grants.some((grant) => grant.static_secret_id === secret.id)) {
    await ironControl.createPrincipalStaticGrant(principal.id, secret.id);
  }
}
