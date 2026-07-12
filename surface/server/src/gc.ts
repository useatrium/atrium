import type { Db } from './db.js';
import { deleteObject } from './s3.js';

export interface FileStorageGc {
  deleteObject: typeof deleteObject;
}

export interface PruneOrphanFilesOptions {
  days?: number;
  batchSize?: number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

export interface PruneOrphanFilesResult {
  scanned: number;
  deleted: number;
  skippedOnError: number;
}

interface FileRow {
  id: string;
  s3_key: string;
}

const DEFAULT_DAYS = 7;
const DEFAULT_BATCH_SIZE = 100;

export async function pruneOrphanFiles(
  pool: Db,
  fileStorage: FileStorageGc,
  opts: PruneOrphanFilesOptions = {},
): Promise<PruneOrphanFilesResult> {
  const days = opts.days ?? fileGcDaysFromEnv();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const logger = opts.logger ?? console;
  const result: PruneOrphanFilesResult = { scanned: 0, deleted: 0, skippedOnError: 0 };

  if (days <= 0) {
    logger.log?.('orphan file prune disabled');
    return result;
  }

  const seen = new Set<string>();
  for (;;) {
    const rows = await findOrphanFiles(pool, days, batchSize, [...seen]);
    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      seen.add(row.id);
      try {
        await fileStorage.deleteObject(row.s3_key);
      } catch (err) {
        if (!isMissingObjectError(err)) {
          result.skippedOnError += 1;
          logger.warn?.({ err, fileId: row.id, s3Key: row.s3_key }, 'orphan file object delete failed');
          continue;
        }
      }

      const deleted = await pool.query<{ id: string }>(
        `DELETE FROM files f
          WHERE f.id = $1
            AND f.created_at < now() - ($2::int * interval '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.type = 'message.posted'
                AND jsonb_typeof(e.payload->'attachments') = 'array'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(e.payload->'attachments') a
                  WHERE a->>'id' = f.id::text
                )
            )
          RETURNING id`,
        [row.id, days],
      );
      if ((deleted.rowCount ?? 0) > 0) result.deleted += 1;
    }
  }

  logger.log?.(
    `orphan file prune scanned=${result.scanned} deleted=${result.deleted} skippedOnError=${result.skippedOnError}`,
  );
  return result;
}

async function findOrphanFiles(pool: Db, days: number, batchSize: number, excludedIds: string[]): Promise<FileRow[]> {
  const res = await pool.query<FileRow>(
    `SELECT f.id::text AS id, f.s3_key
       FROM files f
      WHERE f.created_at < now() - ($1::int * interval '1 day')
        AND NOT (f.id = ANY($3::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.type = 'message.posted'
            AND jsonb_typeof(e.payload->'attachments') = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(e.payload->'attachments') a
              WHERE a->>'id' = f.id::text
            )
        )
      ORDER BY f.created_at ASC
      LIMIT $2`,
    [days, batchSize, excludedIds],
  );
  return res.rows;
}

function fileGcDaysFromEnv(): number {
  const raw = process.env.ATRIUM_FILE_GC_DAYS;
  if (raw == null || raw.trim() === '') return DEFAULT_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAYS;
  return Math.floor(parsed);
}

function isMissingObjectError(err: unknown): boolean {
  const candidate = err as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.Code === 'NoSuchKey' ||
    candidate?.code === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}
