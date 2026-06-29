import type { Db, DbClient } from './db.js';
import { isWorkspaceMember, workspaceIdsFor } from './membership.js';

export const GITHUB_CONNECTION_PROVIDER = 'github';

export type ConnectionProvider = typeof GITHUB_CONNECTION_PROVIDER | (string & {});
export type ConnectionStatusValue = 'connected' | 'needs_auth' | 'public_read' | 'unavailable';
export type ConnectionTokenKind = 'pat' | 'app_installation' | 'app_user' | 'public_read' | (string & {});

export interface ConnectionStatusJson {
  id: string;
  provider: ConnectionProvider;
  workspaceId: string;
  connected: boolean;
  status: ConnectionStatusValue;
  tokenKind: ConnectionTokenKind | null;
  accountLogin: string | null;
  accountLabel: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  identities: ConnectionIdentityJson[];
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface ConnectionIdentityJson {
  id: string;
  provider: ConnectionProvider;
  workspaceId: string;
  active: boolean;
  connected: boolean;
  status: Exclude<ConnectionStatusValue, 'public_read' | 'unavailable'>;
  tokenKind: Exclude<ConnectionTokenKind, 'public_read'>;
  accountLogin: string | null;
  accountLabel: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

interface ConnectionRow {
  workspace_id: string;
  user_id: string;
  provider: string;
  status: ConnectionStatusValue;
  token_kind: string | null;
  account_login: string | null;
  account_label: string | null;
  scopes: string[] | null;
  capabilities: unknown;
  metadata: unknown;
  last_validated_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

interface ConnectionIdentityRow {
  workspace_id: string;
  user_id: string;
  provider: string;
  identity_id: string;
  status: Exclude<ConnectionStatusValue, 'public_read' | 'unavailable'>;
  token_kind: Exclude<ConnectionTokenKind, 'public_read'>;
  account_login: string | null;
  account_label: string | null;
  scopes: string[] | null;
  capabilities: unknown;
  metadata: unknown;
  active: boolean;
  last_validated_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

type Queryable = Pick<Db | DbClient, 'query'>;

export class Connections {
  constructor(private readonly pool: Db) {}

  async withConnectionLock<T>(
    workspaceId: string,
    userId: string,
    provider: ConnectionProvider,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `connection:${workspaceId}:${userId}:${provider}`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
      client.release();
    }
  }

  async resolveWorkspaceId(userId: string, requestedWorkspaceId?: string | null): Promise<string | null> {
    const requested = requestedWorkspaceId?.trim();
    if (requested) {
      return (await isWorkspaceMember(this.pool, userId, requested)) ? requested : null;
    }
    return (await workspaceIdsFor(this.pool, userId))[0] ?? null;
  }

  async list(userId: string, workspaceId: string, client: Queryable = this.pool): Promise<ConnectionStatusJson[]> {
    const connectionsRes = await client.query<ConnectionRow>(
      `SELECT workspace_id, user_id, provider, status, token_kind, account_login, account_label,
              scopes, capabilities, metadata, last_validated_at, last_error, updated_at
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const identitiesRes = await client.query<ConnectionIdentityRow>(
      `SELECT workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_label,
              scopes, capabilities, metadata, active, last_validated_at, last_error, updated_at
         FROM user_connection_identities
        WHERE workspace_id = $1 AND user_id = $2
        ORDER BY active DESC, updated_at DESC, identity_id ASC`,
      [workspaceId, userId],
    );
    const byProvider = new Map(connectionsRes.rows.map((row) => [row.provider, row]));
    const identitiesByProvider = new Map<string, ConnectionIdentityJson[]>();
    for (const row of identitiesRes.rows) {
      const identity = connectionIdentityFromRow(row);
      const bucket = identitiesByProvider.get(row.provider) ?? [];
      bucket.push(identity);
      identitiesByProvider.set(row.provider, bucket);
    }
    return [
      connectionStatusFromRow(
        GITHUB_CONNECTION_PROVIDER,
        workspaceId,
        byProvider.get(GITHUB_CONNECTION_PROVIDER) ?? null,
        identitiesByProvider.get(GITHUB_CONNECTION_PROVIDER) ?? [],
      ),
    ];
  }

  async upsertGitHubMetadata(
    args: {
      workspaceId: string;
      userId: string;
      status: Exclude<ConnectionStatusValue, 'public_read'>;
      tokenKind: Exclude<ConnectionTokenKind, 'public_read'>;
      accountLogin?: string | null;
      accountLabel?: string | null;
      scopes?: readonly string[];
      capabilities?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      lastError?: string | null;
    },
    client: Queryable = this.pool,
  ): Promise<ConnectionStatusJson> {
    const identityId = githubConnectionId({ tokenKind: args.tokenKind, metadata: args.metadata });
    await client.query(
      `UPDATE user_connection_identities
          SET active = false,
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND identity_id <> $4 AND active`,
      [args.workspaceId, args.userId, GITHUB_CONNECTION_PROVIDER, identityId],
    );
    const res = await client.query<ConnectionRow>(
      `INSERT INTO user_connections
         (workspace_id, user_id, provider, status, token_kind, account_login, account_label,
          scopes, capabilities, metadata, last_validated_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10::jsonb,
               CASE WHEN $4 = 'connected' THEN now() ELSE NULL END, $11)
       ON CONFLICT (workspace_id, user_id, provider) DO UPDATE
       SET status = EXCLUDED.status,
           token_kind = EXCLUDED.token_kind,
           account_login = EXCLUDED.account_login,
           account_label = EXCLUDED.account_label,
           scopes = EXCLUDED.scopes,
           capabilities = EXCLUDED.capabilities,
           metadata = EXCLUDED.metadata,
           last_validated_at = CASE WHEN EXCLUDED.status = 'connected' THEN now() ELSE user_connections.last_validated_at END,
           last_error = EXCLUDED.last_error,
           updated_at = now()
       RETURNING workspace_id, user_id, provider, status, token_kind, account_login, account_label,
                 scopes, capabilities, metadata, last_validated_at, last_error, updated_at`,
      [
        args.workspaceId,
        args.userId,
        GITHUB_CONNECTION_PROVIDER,
        args.status,
        args.tokenKind,
        args.accountLogin ?? null,
        args.accountLabel ?? args.accountLogin ?? null,
        normalizeScopes(args.scopes ?? []),
        JSON.stringify(args.capabilities ?? {}),
        JSON.stringify(args.metadata ?? {}),
        args.lastError ?? null,
      ],
    );
    await client.query(
      `INSERT INTO user_connection_identities
         (workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_label,
          scopes, capabilities, metadata, active, last_validated_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11::jsonb, true,
               CASE WHEN $5 = 'connected' THEN now() ELSE NULL END, $12)
       ON CONFLICT (workspace_id, user_id, provider, identity_id) DO UPDATE
       SET status = EXCLUDED.status,
           token_kind = EXCLUDED.token_kind,
           account_login = EXCLUDED.account_login,
           account_label = EXCLUDED.account_label,
           scopes = EXCLUDED.scopes,
           capabilities = EXCLUDED.capabilities,
           metadata = EXCLUDED.metadata,
           active = true,
           last_validated_at = CASE WHEN EXCLUDED.status = 'connected' THEN now() ELSE user_connection_identities.last_validated_at END,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
      [
        args.workspaceId,
        args.userId,
        GITHUB_CONNECTION_PROVIDER,
        identityId,
        args.status,
        args.tokenKind,
        args.accountLogin ?? null,
        args.accountLabel ?? args.accountLogin ?? null,
        normalizeScopes(args.scopes ?? []),
        JSON.stringify(args.capabilities ?? {}),
        JSON.stringify(args.metadata ?? {}),
        args.lastError ?? null,
      ],
    );
    const identities = await listConnectionIdentities(
      client,
      args.workspaceId,
      args.userId,
      GITHUB_CONNECTION_PROVIDER,
    );
    return connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, args.workspaceId, res.rows[0] ?? null, identities);
  }

  async gitHubIdentityStaticSecretIds(
    workspaceId: string,
    userId: string,
    exceptIdentityId?: string | null,
    client: Queryable = this.pool,
  ): Promise<string[]> {
    const res = await client.query<{ metadata: unknown }>(
      `SELECT metadata
         FROM user_connection_identities
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3
          AND ($4::text IS NULL OR identity_id <> $4)`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER, exceptIdentityId ?? null],
    );
    const ids = res.rows
      .map((row) => metadataString(row.metadata, 'staticSecretId'))
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }

  async activateGitHubIdentity(
    workspaceId: string,
    userId: string,
    identityId: string,
    client: Queryable = this.pool,
  ): Promise<ConnectionStatusJson | null> {
    const selected = await client.query<ConnectionIdentityRow>(
      `SELECT workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_label,
              scopes, capabilities, metadata, active, last_validated_at, last_error, updated_at
         FROM user_connection_identities
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND identity_id = $4
        LIMIT 1`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER, identityId],
    );
    const identity = selected.rows[0];
    if (!identity) return null;
    await client.query(
      `UPDATE user_connection_identities
          SET active = false,
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND active`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER],
    );
    await client.query(
      `UPDATE user_connection_identities
          SET active = true,
              status = 'connected',
              last_error = NULL,
              last_validated_at = COALESCE(last_validated_at, now()),
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND identity_id = $4`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER, identityId],
    );
    const active = await client.query<ConnectionRow>(
      `INSERT INTO user_connections
         (workspace_id, user_id, provider, status, token_kind, account_login, account_label,
          scopes, capabilities, metadata, last_validated_at, last_error)
       VALUES ($1, $2, $3, 'connected', $4, $5, $6, $7::text[], $8::jsonb, $9::jsonb,
               COALESCE($10::timestamptz, now()), NULL)
       ON CONFLICT (workspace_id, user_id, provider) DO UPDATE
       SET status = 'connected',
           token_kind = EXCLUDED.token_kind,
           account_login = EXCLUDED.account_login,
           account_label = EXCLUDED.account_label,
           scopes = EXCLUDED.scopes,
           capabilities = EXCLUDED.capabilities,
           metadata = EXCLUDED.metadata,
           last_validated_at = EXCLUDED.last_validated_at,
           last_error = NULL,
           updated_at = now()
       RETURNING workspace_id, user_id, provider, status, token_kind, account_login, account_label,
                 scopes, capabilities, metadata, last_validated_at, last_error, updated_at`,
      [
        workspaceId,
        userId,
        GITHUB_CONNECTION_PROVIDER,
        identity.token_kind,
        identity.account_login,
        identity.account_label,
        normalizeScopes(identity.scopes ?? []),
        JSON.stringify(plainRecord(identity.capabilities)),
        JSON.stringify(plainRecord(identity.metadata)),
        identity.last_validated_at,
      ],
    );
    const identities = await listConnectionIdentities(client, workspaceId, userId, GITHUB_CONNECTION_PROVIDER);
    return connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, workspaceId, active.rows[0] ?? null, identities);
  }

  async disconnectGitHub(
    workspaceId: string,
    userId: string,
    client: Queryable = this.pool,
  ): Promise<ConnectionStatusJson> {
    await client.query(
      `DELETE FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER],
    );
    await client.query(
      `UPDATE user_connection_identities
          SET active = false,
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND active`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER],
    );
    const identities = await listConnectionIdentities(client, workspaceId, userId, GITHUB_CONNECTION_PROVIDER);
    return connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, workspaceId, null, identities);
  }

  async markGitHubNeedsAuth(
    workspaceId: string,
    userId: string,
    message: string,
    client: Queryable = this.pool,
  ): Promise<void> {
    await client.query(
      `INSERT INTO user_connections
         (workspace_id, user_id, provider, status, token_kind, last_error)
       VALUES ($1, $2, $3, 'needs_auth', 'public_read', $4)
       ON CONFLICT (workspace_id, user_id, provider) DO UPDATE
       SET status = 'needs_auth',
           token_kind = COALESCE(user_connections.token_kind, 'public_read'),
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER, message],
    );
    await client.query(
      `UPDATE user_connection_identities
          SET active = false,
              status = 'needs_auth',
              last_error = $4,
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND provider = $3 AND active`,
      [workspaceId, userId, GITHUB_CONNECTION_PROVIDER, message],
    );
  }
}

export function connectionStatusFromRow(
  provider: ConnectionProvider,
  workspaceId: string,
  row: ConnectionRow | null,
  identities: ConnectionIdentityJson[] = [],
): ConnectionStatusJson {
  if (!row) {
    return {
      id: githubConnectionId({ tokenKind: 'public_read' }),
      provider,
      workspaceId,
      connected: false,
      status: 'public_read',
      tokenKind: 'public_read',
      accountLogin: null,
      accountLabel: null,
      scopes: [],
      capabilities: {},
      metadata: {},
      identities,
      lastValidatedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }
  return {
    id: githubConnectionId({ tokenKind: row.token_kind, metadata: row.metadata }),
    provider: row.provider,
    workspaceId: row.workspace_id,
    connected: row.status === 'connected',
    status: row.status,
    tokenKind: row.token_kind,
    accountLogin: row.account_login,
    accountLabel: row.account_label,
    scopes: normalizeScopes(row.scopes ?? []),
    capabilities: plainRecord(row.capabilities),
    metadata: plainRecord(row.metadata),
    identities,
    lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function connectionIdentityFromRow(row: ConnectionIdentityRow): ConnectionIdentityJson {
  return {
    id: row.identity_id,
    provider: row.provider,
    workspaceId: row.workspace_id,
    active: row.active,
    connected: row.status === 'connected',
    status: row.status,
    tokenKind: row.token_kind,
    accountLogin: row.account_login,
    accountLabel: row.account_label,
    scopes: normalizeScopes(row.scopes ?? []),
    capabilities: plainRecord(row.capabilities),
    metadata: plainRecord(row.metadata),
    lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listConnectionIdentities(
  client: Queryable,
  workspaceId: string,
  userId: string,
  provider: ConnectionProvider,
): Promise<ConnectionIdentityJson[]> {
  const res = await client.query<ConnectionIdentityRow>(
    `SELECT workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_label,
            scopes, capabilities, metadata, active, last_validated_at, last_error, updated_at
       FROM user_connection_identities
      WHERE workspace_id = $1 AND user_id = $2 AND provider = $3
      ORDER BY active DESC, updated_at DESC, identity_id ASC`,
    [workspaceId, userId, provider],
  );
  return res.rows.map(connectionIdentityFromRow);
}

export function githubConnectionId(args: { tokenKind?: string | null; metadata?: unknown }): string {
  switch (args.tokenKind) {
    case 'app_installation': {
      const installationId = metadataString(args.metadata, 'installationId');
      return installationId ? `github:app_installation:${installationId}` : 'github:app_installation';
    }
    case 'app_user':
      return 'github:app_user';
    case 'pat':
      return 'github:pat';
    default:
      return 'github:public_read';
  }
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
