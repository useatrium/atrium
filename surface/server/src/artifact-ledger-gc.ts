// CAS-ledger blob GC. Periodically deletes content-addressed blobs that no
// artifact version references after a grace window, reclaiming capture churn.

import { config } from './config.js';
import type { Db } from './db.js';

export interface ArtifactBlobStorage {
  deleteObject(key: string): Promise<void>;
}

export interface ArtifactGcSweepOptions {
  graceMs: number;
  limit: number;
}

export interface ArtifactGcSweepResult {
  swept: number;
  failed: number;
}

export interface ArtifactGcWorkerOptions {
  pool: Db;
  storage: ArtifactBlobStorage;
  intervalMs?: number;
  graceMs?: number;
  batchSize?: number;
}

export interface ArtifactGcWorker {
  /** Trigger a batch immediately (used by tests; the interval calls it too). */
  runOnce(): Promise<void>;
  stop(): void;
}

export async function sweepUnreferencedBlobs(
  pool: Db,
  storage: ArtifactBlobStorage,
  options: ArtifactGcSweepOptions,
): Promise<ArtifactGcSweepResult> {
  const candidates = await pool.query<{ sha256: string; s3_key: string | null }>(
    `SELECT sha256, s3_key
       FROM cas_blobs b
      WHERE b.created_at < now() - ($1::double precision * interval '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM artifact_blob_refs r WHERE r.sha = b.sha256
        )
      ORDER BY b.created_at ASC
      LIMIT $2`,
    [options.graceMs, options.limit],
  );

  let swept = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    try {
      if (row.s3_key) {
        await storage.deleteObject(row.s3_key);
      }
      await pool.query('DELETE FROM cas_blobs WHERE sha256 = $1', [row.sha256]);
      swept += 1;
    } catch (err) {
      failed += 1;
      console.warn('artifact blob gc row failed', { sha256: row.sha256, err });
    }
  }

  return { swept, failed };
}

/**
 * Start the artifact blob GC worker. Runs never overlap: an `inFlight` guard
 * skips a tick if the previous sweep is still going. The timer is `unref`'d so
 * it never keeps the process alive. Errors are swallowed so the interval
 * survives transient storage/database failures.
 */
export function startArtifactGcWorker(options: ArtifactGcWorkerOptions): ArtifactGcWorker {
  const { pool, storage } = options;
  const intervalMs = options.intervalMs ?? config.artifactGcIntervalMs;
  const graceMs = options.graceMs ?? config.artifactGcGraceMs;
  const batchSize = options.batchSize ?? config.artifactGcBatchSize;
  let inFlight = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await sweepUnreferencedBlobs(pool, storage, { graceMs, limit: batchSize });
    } catch (err) {
      // sweepUnreferencedBlobs handles per-row errors; this catches an
      // unexpected failure (e.g. the candidate query) so the interval survives.
      console.warn('artifact blob gc batch failed', err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
