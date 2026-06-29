import { describe, expect, it } from 'vitest';
import { githubConnectionAuditMetadata } from '../src/connection-audit.js';

describe('githubConnectionAuditMetadata', () => {
  it('emits stable GitHub connection audit fields without token material', () => {
    const audit = githubConnectionAuditMetadata({
      action: 'connect',
      result: 'success',
      workspaceId: 'workspace-1',
      actorUserId: 'user-1',
      credentialOwnerUserId: 'user-1',
      connection: {
        id: 'github:pat',
        provider: 'github',
        workspaceId: 'workspace-1',
        connected: true,
        status: 'connected',
        tokenKind: 'pat',
        accountLogin: 'octo',
        accountLabel: 'Octo',
        scopes: ['repo'],
        capabilities: { repoAccess: true, token: 'ghp_secret_secret_secret' },
        metadata: {
          last4: '1234',
          authorization: 'Bearer ghp_secret_secret_secret',
          nested: { refreshToken: 'github_pat_secret_secret_secret' },
        },
        identities: [],
        lastValidatedAt: '2026-06-28T00:00:00.000Z',
        lastError: null,
        updatedAt: '2026-06-28T00:00:00.000Z',
      },
    });

    expect(audit).toMatchObject({
      event: 'github_connection_audit',
      provider: 'github',
      action: 'connect',
      result: 'success',
      workspace_id: 'workspace-1',
      actor_user_id: 'user-1',
      credential_owner_user_id: 'user-1',
      principal_foreign_id: 'atrium-workspace-workspace-1-user-user-1',
      status: 'connected',
      token_kind: 'pat',
      account_login: 'octo',
      scopes: ['repo'],
    });
    expect(JSON.stringify(audit)).not.toContain('ghp_secret_secret_secret');
    expect(JSON.stringify(audit)).not.toContain('github_pat_secret_secret_secret');
    expect(audit.metadata).toMatchObject({
      last4: '1234',
      authorization: '[redacted]',
      nested: { refreshToken: '[redacted]' },
    });
  });
});
