import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';

export const CLAUDE_CODE_PROVIDER = 'claude-code';
const CLAUDE_CODE_OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export type ProviderCredentialProvider = typeof CLAUDE_CODE_PROVIDER;
export type ProviderCredentialStatusValue = 'connected' | 'needs_auth';

export interface ProviderCredentialStatusJson {
  provider: ProviderCredentialProvider;
  connected: boolean;
  status: ProviderCredentialStatusValue;
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface ProviderAuthRequiredJson {
  provider: ProviderCredentialProvider;
  userId: string;
  reason: 'missing_token' | 'invalid_token' | 'auth_error';
  message: string;
  at: string;
}

interface CredentialRow {
  user_id: string;
  provider: string;
  token_ciphertext: string;
  status: ProviderCredentialStatusValue;
  last_validated_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

type Queryable = Pick<Db | DbClient, 'query'>;

export class ProviderCredentials {
  constructor(
    private readonly pool: Db,
    private readonly secret = config.providerCredentialSecret,
  ) {}

  async list(userId: string): Promise<ProviderCredentialStatusJson[]> {
    const res = await this.pool.query<CredentialRow>(
      `SELECT user_id, provider, token_ciphertext, status, last_validated_at, last_error, updated_at
       FROM user_provider_credentials
       WHERE user_id = $1 AND provider = $2`,
      [userId, CLAUDE_CODE_PROVIDER],
    );
    return [statusFromRow(res.rows[0] ?? null)];
  }

  async upsertClaudeToken(userId: string, token: string): Promise<ProviderCredentialStatusJson> {
    const normalized = token.trim();
    if (!normalized) {
      throw new Error('Claude token is required');
    }
    const ciphertext = encryptSecret(this.secret, normalized);
    const res = await this.pool.query<CredentialRow>(
      `INSERT INTO user_provider_credentials
         (user_id, provider, token_ciphertext, status, last_validated_at, last_error)
       VALUES ($1, $2, $3, 'connected', now(), NULL)
       ON CONFLICT (user_id, provider) DO UPDATE
       SET token_ciphertext = EXCLUDED.token_ciphertext,
           status = 'connected',
           last_validated_at = now(),
           last_error = NULL,
           updated_at = now()
       RETURNING user_id, provider, token_ciphertext, status, last_validated_at, last_error, updated_at`,
      [userId, CLAUDE_CODE_PROVIDER, ciphertext],
    );
    return statusFromRow(res.rows[0] ?? null);
  }

  async deleteClaudeToken(userId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM user_provider_credentials WHERE user_id = $1 AND provider = $2',
      [userId, CLAUDE_CODE_PROVIDER],
    );
  }

  async getClaudeToken(
    userId: string,
    client: Queryable = this.pool,
  ): Promise<string | null> {
    const res = await client.query<Pick<CredentialRow, 'token_ciphertext' | 'status'>>(
      `SELECT token_ciphertext, status
       FROM user_provider_credentials
       WHERE user_id = $1 AND provider = $2`,
      [userId, CLAUDE_CODE_PROVIDER],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'connected') return null;
    return decryptSecret(this.secret, row.token_ciphertext);
  }

  async markClaudeAuthRequired(
    userId: string,
    message: string,
    client: Queryable = this.pool,
  ): Promise<void> {
    await client.query(
      `UPDATE user_provider_credentials
       SET status = 'needs_auth',
           last_error = $3,
           updated_at = now()
       WHERE user_id = $1 AND provider = $2`,
      [userId, CLAUDE_CODE_PROVIDER, message],
    );
  }
}

export function claudeExecutionEnvironment(token: string): Record<string, string> {
  return { [CLAUDE_CODE_OAUTH_ENV]: token };
}

export function claudeAuthRequired(
  userId: string,
  reason: ProviderAuthRequiredJson['reason'],
  message = 'Reconnect Claude Code to continue this session.',
): ProviderAuthRequiredJson {
  return {
    provider: CLAUDE_CODE_PROVIDER,
    userId,
    reason,
    message,
    at: new Date().toISOString(),
  };
}

export function isClaudeAuthFailureText(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  return (
    (text.includes('invalid bearer token') ||
      text.includes('401') ||
      text.includes('unauthorized') ||
      text.includes('claude_code_oauth_token')) &&
    (text.includes('claude') || text.includes('anthropic') || text.includes('bearer'))
  );
}

function statusFromRow(row: CredentialRow | null): ProviderCredentialStatusJson {
  if (!row) {
    return {
      provider: CLAUDE_CODE_PROVIDER,
      connected: false,
      status: 'needs_auth',
      lastValidatedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }
  return {
    provider: CLAUDE_CODE_PROVIDER,
    connected: row.status === 'connected',
    status: row.status,
    lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function encryptSecret(secret: string, plaintext: string): string {
  const key = keyFromSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decryptSecret(secret: string, value: string): string {
  const [version, iv64, tag64, ciphertext64] = value.split(':');
  if (version !== 'v1' || !iv64 || !tag64 || !ciphertext64) {
    throw new Error('unsupported credential ciphertext');
  }
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}
