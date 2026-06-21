import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';

export const CLAUDE_CODE_PROVIDER = 'claude-code';
export const CODEX_PROVIDER = 'codex';
const CLAUDE_CODE_OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const CODEX_AUTH_JSON_ENV = 'CODEX_AUTH_JSON';

export type ProviderCredentialProvider = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_PROVIDER;
export type ProviderCredentialStatusValue = 'connected' | 'needs_auth';

const PROVIDERS: readonly ProviderCredentialProvider[] = [CLAUDE_CODE_PROVIDER, CODEX_PROVIDER];

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
       WHERE user_id = $1 AND provider = ANY($2::text[])`,
      [userId, PROVIDERS],
    );
    const byProvider = new Map(
      res.rows
        .filter((row): row is CredentialRow & { provider: ProviderCredentialProvider } =>
          isProviderCredentialProvider(row.provider),
        )
        .map((row) => [row.provider, row]),
    );
    return PROVIDERS.map((provider) => statusFromRow(provider, byProvider.get(provider) ?? null));
  }

  async upsertClaudeToken(userId: string, token: string): Promise<ProviderCredentialStatusJson> {
    const normalized = token.trim();
    if (!normalized) {
      throw new Error('Claude token is required');
    }
    return this.upsertProviderSecret(userId, CLAUDE_CODE_PROVIDER, normalized);
  }

  async upsertCodexAuthJson(userId: string, authJson: string): Promise<ProviderCredentialStatusJson> {
    return this.upsertProviderSecret(userId, CODEX_PROVIDER, normalizeCodexAuthJson(authJson));
  }

  private async upsertProviderSecret(
    userId: string,
    provider: ProviderCredentialProvider,
    secretValue: string,
  ): Promise<ProviderCredentialStatusJson> {
    const ciphertext = encryptSecret(this.secret, secretValue);
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
      [userId, provider, ciphertext],
    );
    return statusFromRow(provider, res.rows[0] ?? null);
  }

  async deleteClaudeToken(userId: string): Promise<void> {
    await this.deleteProviderSecret(userId, CLAUDE_CODE_PROVIDER);
  }

  async deleteCodexAuthJson(userId: string): Promise<void> {
    await this.deleteProviderSecret(userId, CODEX_PROVIDER);
  }

  private async deleteProviderSecret(
    userId: string,
    provider: ProviderCredentialProvider,
  ): Promise<void> {
    await this.pool.query(
      'DELETE FROM user_provider_credentials WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
  }

  async getClaudeToken(
    userId: string,
    client: Queryable = this.pool,
  ): Promise<string | null> {
    return this.getProviderSecret(userId, CLAUDE_CODE_PROVIDER, client);
  }

  async getCodexAuthJson(
    userId: string,
    client: Queryable = this.pool,
  ): Promise<string | null> {
    return this.getProviderSecret(userId, CODEX_PROVIDER, client);
  }

  async getProviderSecret(
    userId: string,
    provider: ProviderCredentialProvider,
    client: Queryable = this.pool,
  ): Promise<string | null> {
    const res = await client.query<Pick<CredentialRow, 'token_ciphertext' | 'status'>>(
      `SELECT token_ciphertext, status
       FROM user_provider_credentials
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
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
    await this.markProviderAuthRequired(CLAUDE_CODE_PROVIDER, userId, message, client);
  }

  async markCodexAuthRequired(
    userId: string,
    message: string,
    client: Queryable = this.pool,
  ): Promise<void> {
    await this.markProviderAuthRequired(CODEX_PROVIDER, userId, message, client);
  }

  async markProviderAuthRequired(
    provider: ProviderCredentialProvider,
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
      [userId, provider, message],
    );
  }
}

export function claudeExecutionEnvironment(token: string): Record<string, string> {
  return { [CLAUDE_CODE_OAUTH_ENV]: token };
}

export function codexExecutionEnvironment(authJson: string): Record<string, string> {
  return { [CODEX_AUTH_JSON_ENV]: authJson };
}

export function claudeAuthRequired(
  userId: string,
  reason: ProviderAuthRequiredJson['reason'],
  message = 'Reconnect Claude Code to continue this session.',
): ProviderAuthRequiredJson {
  return providerAuthRequired(CLAUDE_CODE_PROVIDER, userId, reason, message);
}

export function codexAuthRequired(
  userId: string,
  reason: ProviderAuthRequiredJson['reason'],
  message = 'Reconnect Codex to continue this session.',
): ProviderAuthRequiredJson {
  return providerAuthRequired(CODEX_PROVIDER, userId, reason, message);
}

export function providerAuthRequired(
  provider: ProviderCredentialProvider,
  userId: string,
  reason: ProviderAuthRequiredJson['reason'],
  message: string,
): ProviderAuthRequiredJson {
  return {
    provider,
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

export function isCodexAuthFailureText(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  return (
    text.includes('codex') &&
    (text.includes('not logged in') ||
      text.includes('login') ||
      text.includes('auth') ||
      text.includes('credential') ||
      text.includes('401') ||
      text.includes('unauthorized') ||
      text.includes('codex_access_token') ||
      text.includes('auth.json') ||
      text.includes('openai_api_key'))
  );
}

export function isProviderAuthFailureText(
  value: string | null | undefined,
): boolean {
  return isClaudeAuthFailureText(value) || isCodexAuthFailureText(value);
}

export function isProviderCredentialProvider(value: string): value is ProviderCredentialProvider {
  return value === CLAUDE_CODE_PROVIDER || value === CODEX_PROVIDER;
}

export function providerForHarness(harness: string): ProviderCredentialProvider | null {
  if (harness === CLAUDE_CODE_PROVIDER) return CLAUDE_CODE_PROVIDER;
  if (harness === CODEX_PROVIDER) return CODEX_PROVIDER;
  return null;
}

export function providerDisplayName(provider: ProviderCredentialProvider): string {
  return provider === CLAUDE_CODE_PROVIDER ? 'Claude Code' : 'Codex';
}

function statusFromRow(
  provider: ProviderCredentialProvider,
  row: CredentialRow | null,
): ProviderCredentialStatusJson {
  if (!row) {
    return {
      provider,
      connected: false,
      status: 'needs_auth',
      lastValidatedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }
  return {
    provider,
    connected: row.status === 'connected',
    status: row.status,
    lastValidatedAt: row.last_validated_at ? row.last_validated_at.toISOString() : null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizeCodexAuthJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Codex auth.json is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Codex auth.json must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex auth.json must be a JSON object');
  }

  const auth = parsed as Record<string, unknown>;
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
    throw new Error('Codex auth.json must use ChatGPT login, not an OPENAI_API_KEY');
  }
  if (auth.auth_mode !== 'chatgpt') {
    throw new Error('Codex auth.json must have auth_mode "chatgpt"');
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('Codex auth.json must include tokens');
  }
  const accessToken = (tokens as Record<string, unknown>).access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Codex auth.json must include tokens.access_token');
  }

  return JSON.stringify({ ...auth, OPENAI_API_KEY: null });
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
