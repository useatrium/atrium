import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';

// Shared scaffolding for the provider "Connect" OAuth handshakes (Codex device
// grant, Claude authorization-code + PKCE). Lanes A/B build their provider flows
// on top of this: PKCE generation, a sealed short-lived handshake store, and the
// small HTTP helper for form-encoded token endpoints.

type Queryable = Pick<Db | DbClient, 'query'>;

export type OAuthKind = 'device' | 'pkce';
export type OAuthPendingStatus = 'pending' | 'authorized' | 'error';

export interface PendingOAuthRow<S = unknown> {
  id: string;
  userId: string;
  provider: string;
  kind: OAuthKind;
  state: S;
  status: OAuthPendingStatus;
  lastError: string | null;
  expiresAt: Date;
}

// ── PKCE (RFC 7636, S256) ────────────────────────────────────────────────────
export interface Pkce {
  verifier: string;
  challenge: string;
}

export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

// ── Sealed short-lived handshake store (oauth_pending) ───────────────────────
export class PendingOAuthStore {
  constructor(
    private readonly pool: Db,
    private readonly secret = config.providerCredentialSecret,
  ) {}

  /** Create (or replace) the single in-flight handshake for (user, provider, kind). */
  async start<S>(args: {
    userId: string;
    provider: string;
    kind: OAuthKind;
    state: S;
    ttlMs: number;
    client?: Queryable;
  }): Promise<string> {
    const client = args.client ?? this.pool;
    // At most one in-flight per (user, provider, kind): drop any prior pending.
    await client.query(
      `DELETE FROM oauth_pending
       WHERE user_id = $1 AND provider = $2 AND kind = $3 AND status = 'pending'`,
      [args.userId, args.provider, args.kind],
    );
    const res = await client.query<{ id: string }>(
      `INSERT INTO oauth_pending (user_id, provider, kind, state_ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'))
       RETURNING id`,
      [args.userId, args.provider, args.kind, seal(this.secret, args.state), args.ttlMs],
    );
    return res.rows[0]!.id;
  }

  /** Fetch the in-flight handshake by id, scoped to the owning user. Null if gone/expired. */
  async get<S>(id: string, userId: string): Promise<PendingOAuthRow<S> | null> {
    const res = await this.pool.query<RawRow>(
      `SELECT id, user_id, provider, kind, state_ciphertext, status, last_error, expires_at
       FROM oauth_pending
       WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? this.decode<S>(row) : null;
  }

  /** Fetch the current pending handshake for (user, provider, kind), if any. */
  async current<S>(
    userId: string,
    provider: string,
    kind: OAuthKind,
  ): Promise<PendingOAuthRow<S> | null> {
    const res = await this.pool.query<RawRow>(
      `SELECT id, user_id, provider, kind, state_ciphertext, status, last_error, expires_at
       FROM oauth_pending
       WHERE user_id = $1 AND provider = $2 AND kind = $3 AND status = 'pending'
         AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, provider, kind],
    );
    const row = res.rows[0];
    return row ? this.decode<S>(row) : null;
  }

  async markError(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE oauth_pending SET status = 'error', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, message.slice(0, 500)],
    );
  }

  /** Delete the handshake and return its sealed state (single-use consumption). */
  async consume<S>(id: string, userId: string): Promise<PendingOAuthRow<S> | null> {
    const res = await this.pool.query<RawRow>(
      `DELETE FROM oauth_pending
       WHERE id = $1 AND user_id = $2 AND expires_at > now()
       RETURNING id, user_id, provider, kind, state_ciphertext, status, last_error, expires_at`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? this.decode<S>(row) : null;
  }

  async cleanupExpired(): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_pending WHERE expires_at <= now()`);
  }

  private decode<S>(row: RawRow): PendingOAuthRow<S> {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      kind: row.kind as OAuthKind,
      state: unseal<S>(this.secret, row.state_ciphertext),
      status: row.status as OAuthPendingStatus,
      lastError: row.last_error,
      expiresAt: row.expires_at,
    };
  }
}

interface RawRow {
  id: string;
  user_id: string;
  provider: string;
  kind: string;
  state_ciphertext: string;
  status: string;
  last_error: string | null;
  expires_at: Date;
}

// ── form-encoded token-endpoint POST (both providers use x-www-form-urlencoded) ─
export async function postForm<T = unknown>(
  url: string,
  form: Record<string, string>,
  init?: { headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    body: new URLSearchParams(form).toString(),
  });
  return { ok: res.ok, status: res.status, body: (await readResponseBody(res)) as T };
}

// ── JSON-body token-endpoint POST ────────────────────────────────────────────
// Codex's device-authorization endpoints (`/api/accounts/deviceauth/*`) require
// a JSON request body, not form encoding. (The `/oauth/token` exchange itself is
// still form-encoded — use postForm for that.)
export async function postJson<T = unknown>(
  url: string,
  payload: Record<string, unknown>,
  init?: { headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: (await readResponseBody(res)) as T };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

// ── AES-256-GCM seal/unseal (shape-compatible with provider-credentials.ts) ──
function seal(secret: string, value: unknown): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function unseal<S>(secret: string, value: string): S {
  const [version, iv64, tag64, ciphertext64] = value.split(':');
  if (version !== 'v1' || !iv64 || !tag64 || !ciphertext64) {
    throw new Error('unsupported oauth_pending ciphertext');
  }
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as S;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}
