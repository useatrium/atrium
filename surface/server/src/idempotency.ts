import { createHash } from 'node:crypto';
import type { Db, DbClient } from './db.js';
import { DomainError } from './events.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdempotencyMeta {
  userId: string;
  opId: string;
  opType: string;
  body?: unknown;
  bodyHash?: string;
}

export interface IdempotencyOptions<T> {
  onApplied?: (response: T) => void | Promise<void>;
}

interface IdempotencyRow {
  op_type: string;
  body_hash: string;
  response: unknown | null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function bodyHash(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

export async function withIdempotency<T>(
  pool: Db,
  meta: IdempotencyMeta,
  fn: (client: DbClient) => Promise<T>,
  options: IdempotencyOptions<T> = {},
): Promise<T> {
  if (!isUuid(meta.opId)) {
    throw new DomainError(400, 'bad_request', 'opId must be a uuid');
  }
  const hash = meta.bodyHash ?? bodyHash(meta.body ?? {});
  const client = await pool.connect();
  let applied = false;
  let response: T | undefined;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (user_id, op_id, op_type, body_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING op_type`,
      [meta.userId, meta.opId, meta.opType, hash],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<IdempotencyRow>(
        `SELECT op_type, body_hash, response
         FROM idempotency_keys
         WHERE user_id = $1 AND op_id = $2`,
        [meta.userId, meta.opId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new DomainError(409, 'op_in_flight', 'operation is still in flight');
      }
      if (row.op_type !== meta.opType || row.body_hash !== hash) {
        throw new DomainError(409, 'op_id_reuse', 'opId was already used for a different operation');
      }
      response = row.response as T;
      await client.query('COMMIT');
      return response;
    }

    response = await fn(client);
    await client.query(
      `UPDATE idempotency_keys
       SET response = $1
       WHERE user_id = $2 AND op_id = $3`,
      [JSON.stringify(response ?? null), meta.userId, meta.opId],
    );
    await client.query('COMMIT');
    applied = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (applied && options.onApplied) await options.onApplied(response as T);
  return response as T;
}

export async function pruneIdempotencyKeys(pool: Db): Promise<void> {
  await pool.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'");
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v !== undefined) out[key] = normalize(v);
  }
  return out;
}
