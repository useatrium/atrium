// B1: S3 offload. A periodic background worker that copies captured artifact
// bytes out of Centaur's ephemeral Postgres staging into atrium's durable S3
// (MinIO in dev), so they survive Centaur retention. The byte work + locking
// lives in SessionRuns.offloadArtifactBatch (FOR UPDATE SKIP LOCKED); this
// module owns the interval + lifecycle and ensures a single in-flight run.

import { config } from './config.js';
import type { SessionRuns } from './session-runs.js';

export interface ArtifactOffloadWorkerOptions {
  sessionRuns: SessionRuns;
  intervalMs?: number;
  batchSize?: number;
}

export interface ArtifactOffloadWorker {
  /** Trigger a batch immediately (used by tests; the interval calls it too). */
  runOnce(): Promise<void>;
  stop(): void;
}

/**
 * Start the offload worker. Runs a batch every `intervalMs`. Runs never
 * overlap: an `inFlight` guard skips a tick if the previous batch is still
 * going (a slow S3/Centaur hop must not stack up concurrent transactions). The
 * timer is `unref`'d so it never keeps the process alive. Errors are swallowed
 * (logged inside the batch) so a transient failure can't crash the interval.
 */
export function startArtifactOffloadWorker(
  options: ArtifactOffloadWorkerOptions,
): ArtifactOffloadWorker {
  const { sessionRuns } = options;
  const intervalMs = options.intervalMs ?? config.artifactOffloadIntervalMs;
  const batchSize = options.batchSize ?? config.artifactOffloadBatchSize;
  let inFlight = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await sessionRuns.offloadArtifactBatch(batchSize);
    } catch (err) {
      // offloadArtifactBatch handles per-row errors; this only catches an
      // unexpected failure (e.g. the claim query) so the interval survives.
      console.warn('artifact offload batch failed', err);
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
