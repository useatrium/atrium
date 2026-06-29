import type { Db, DbClient } from './db.js';
import { isWorkspaceMember, workspaceIdsFor } from './membership.js';

export const GITHUB_CONNECTION_PROVIDER = 'github';

export type ConnectionProvider = typeof GITHUB_CONNECTION_PROVIDER | (string & {});
export type ConnectionStatusValue = 'connected' | 'needs_auth' | 'public_read' | 'unavailable';
export type ConnectionTokenKind = 'pat' | 'app_installation' | 'app_user' | 'public_read' | (string & {});

export interface ConnectionStatusJson {
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
    const res = await client.query<ConnectionRow>(
      `SELECT workspace_id, user_id, provider, status, token_kind, account_login, account_label,
              scopes, capabilities, metadata, last_validated_at, last_error, updated_at
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const byProvider = new Map(res.rows.map((row) => [row.provider, row]));
    return [connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, workspaceId, byProvider.get(GITHUB_CONNECTION_PROVIDER) ?? null)];
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
    return connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, args.workspaceId, res.rows[0] ?? null);
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
    return connectionStatusFromRow(GITHUB_CONNECTION_PROVIDER, workspaceId, null);
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
  }
}

export function connectionStatusFromRow(
  provider: ConnectionProvider,
  workspaceId: string,
  row: ConnectionRow | null,
): ConnectionStatusJson {
  if (!row) {
    return {
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
      lastValidatedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }
  return {
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
    lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
