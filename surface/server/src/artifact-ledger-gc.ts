// CAS-ledger blob GC. Periodically deletes content-addressed blobs that no
// artifact version references after a grace window, reclaiming capture churn.

import { config } from './config.js';
import type { Db } from './db.js';
import { withTx } from './db.js';

export interface ArtifactBlobStorage {
  deleteObject(key: string): Promise<void>;
}

export interface ArtifactGcSweepOptions {
  graceMs: number;
  limit: number;
}

export interface ArtifactRetentionSweepOptions {
  retentionMs: number;
  limit: number;
  reason?: string;
}

export interface ArtifactGcSweepResult {
  swept: number;
  failed: number;
}

export interface ArtifactRetentionSweepResult {
  tombstoned: number;
}

export interface ArtifactGcWorkerOptions {
  pool: Db;
  storage: ArtifactBlobStorage;
  intervalMs?: number;
  graceMs?: number;
  retentionMs?: number;
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
        AND NOT EXISTS (
          SELECT 1 FROM app_versions av WHERE av.blob_sha = b.sha256
        )
        AND NOT EXISTS (
          SELECT 1
            FROM agent_profile_versions apv
           WHERE apv.manifest_json->'bundles' @> jsonb_build_array(jsonb_build_object('sha256', b.sha256))
        )
        AND NOT EXISTS (
          SELECT 1 FROM warmcache_blobs w WHERE w.sha256 = b.sha256
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

export async function sweepRetainedScratchVersions(
  pool: Db,
  options: ArtifactRetentionSweepOptions,
): Promise<ArtifactRetentionSweepResult> {
  const reason = options.reason ?? 'scratch_superseded_retention';
  const rows = await withTx(pool, async (client) => {
    const updated = await client.query<{ artifact_id: string; seq: number; sha: string }>(
      `WITH latest_normal AS (
         SELECT DISTINCT ON (artifact_id) artifact_id, seq
           FROM artifact_versions
          WHERE status = 'normal'
          ORDER BY artifact_id, seq DESC
       ),
       candidates AS (
         SELECT v.artifact_id, v.seq, v.blob_sha
           FROM artifact_versions v
           JOIN artifacts a ON a.id = v.artifact_id
           JOIN latest_normal ln ON ln.artifact_id = v.artifact_id
          WHERE a.path ~* '^scratch/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.+'
            AND v.status = 'normal'
            AND v.blob_sha IS NOT NULL
            AND v.retention_tombstoned_at IS NULL
            AND v.created_at < now() - ($1::double precision * interval '1 millisecond')
            AND v.seq <> ln.seq
            AND NOT EXISTS (
              SELECT 1 FROM artifact_pointers p
               WHERE p.artifact_id = v.artifact_id AND p.seq = v.seq
            )
            AND NOT EXISTS (
              SELECT 1 FROM artifact_retention_pins pin
               WHERE pin.artifact_id = v.artifact_id AND pin.seq = v.seq
            )
          ORDER BY v.created_at ASC, v.artifact_id ASC, v.seq ASC
          FOR UPDATE OF v SKIP LOCKED
          LIMIT $2
       )
       UPDATE artifact_versions v
          SET retention_tombstoned_at = now(),
              retention_reason = $3,
              retention_blob_sha = candidates.blob_sha,
              blob_sha = NULL
         FROM candidates
        WHERE v.artifact_id = candidates.artifact_id
          AND v.seq = candidates.seq
        RETURNING v.artifact_id, v.seq, candidates.blob_sha AS sha`,
      [options.retentionMs, options.limit, reason],
    );

    if (updated.rows.length > 0) {
      await client.query(
        `DELETE FROM artifact_blob_refs r
          USING (SELECT unnest($1::uuid[]) AS artifact_id,
                        unnest($2::int[]) AS seq) pruned
          WHERE r.artifact_id = pruned.artifact_id
            AND r.seq = pruned.seq
            AND r.role = 'version'`,
        [updated.rows.map((row) => row.artifact_id), updated.rows.map((row) => row.seq)],
      );
    }

    return updated.rows;
  });

  return { tombstoned: rows.length };
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
  const retentionMs = options.retentionMs ?? config.artifactRetentionMs;
  const batchSize = options.batchSize ?? config.artifactGcBatchSize;
  let inFlight = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await sweepRetainedScratchVersions(pool, { retentionMs, limit: batchSize });
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
