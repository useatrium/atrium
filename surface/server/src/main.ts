import { config } from './config.js';
import { createPool } from './db.js';
import { ensureDefaultWorkspace } from './events.js';
import { runMigrations } from './migrate.js';
import { WsHub } from './hub.js';
import { buildApp } from './app.js';
import { buildAppsOrigin } from './apps-origin.js';
import { pruneIdempotencyKeys } from './idempotency.js';
import { pruneDraftTombstones } from './drafts.js';
import { pruneOrphanFiles } from './gc.js';
import { archiveStaleSessions } from './session-archive.js';
import { deleteObject, startStorageBootstrap } from './s3.js';
import { startArtifactGcWorker, type ArtifactGcWorker } from './artifact-ledger-gc.js';
import { SttWorker } from './stt/worker.js';
import { registerWhisperCppAdapter } from './stt/whispercpp.js';
import { shutdownServerTelemetry } from './telemetry.js';
import { startThumbnailBackfill } from './thumbnails.js';
// === call-sweeper additions ===
import { startCallSweeper } from './call-sweeper.js';

export async function main() {
  if ((process.env.STT_PROVIDER ?? 'noop') === 'whispercpp') {
    registerWhisperCppAdapter();
  }
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const hub = new WsHub();
  await pruneIdempotencyKeys(pool);
  await pruneDraftTombstones(pool);
  await pruneOrphanFiles(pool, { deleteObject }).catch((err) => {
    console.warn('orphan file prune failed', err);
  });
  await archiveStaleSessions(pool, hub).catch((err) => {
    console.warn('stale session archive failed', err);
  });
  const workspace = await ensureDefaultWorkspace(pool);
  const sttWorker = new SttWorker({ pool, hub });
  await sttWorker.sweepOnBoot();
  const heartbeat = hub.startHeartbeat(30_000);
  const idempotencyPrune = setInterval(
    () => {
      void pruneIdempotencyKeys(pool).catch((err) => {
        console.warn('idempotency prune failed', err);
      });
      void pruneDraftTombstones(pool).catch((err) => {
        console.warn('draft tombstone prune failed', err);
      });
    },
    24 * 60 * 60 * 1000,
  );
  idempotencyPrune.unref?.();
  const filePrune = setInterval(
    () => {
      void pruneOrphanFiles(pool, { deleteObject }).catch((err) => {
        console.warn('orphan file prune failed', err);
      });
      void archiveStaleSessions(pool, hub).catch((err) => {
        console.warn('stale session archive failed', err);
      });
    },
    24 * 60 * 60 * 1000,
  );
  filePrune.unref?.();
  const rateLimit = config.rateLimitEnabled ? { max: config.rateLimitMax, loginMax: config.rateLimitLoginMax } : false;
  const app = await buildApp({ pool, hub, stt: sttWorker, rateLimit });
  const appsOrigin = config.appsPort > 0 ? await buildAppsOrigin({ pool }) : null;

  // Storage bootstrap (#215): ensure the S3/MinIO bucket exists, retrying until
  // it does; /healthz stays 503 until the first success so the health-gated
  // deploy catches never-provisioned storage instead of shipping silent 500s.
  const storageBootstrap = startStorageBootstrap(app.log);
  startThumbnailBackfill(pool, app.log);

  // === gc additions ===
  let artifactGc: ArtifactGcWorker | null = null;
  if (config.artifactGcEnabled) {
    artifactGc = startArtifactGcWorker({ pool, storage: { deleteObject } });
  }

  // === call-sweeper additions ===
  const callSweeper = startCallSweeper({ pool, hub });
  void callSweeper.runOnce();

  const shutdown = async () => {
    // === call-sweeper additions ===
    callSweeper.stop();
    sttWorker.stop();
    artifactGc?.stop();
    storageBootstrap.stop();
    clearInterval(heartbeat);
    clearInterval(idempotencyPrune);
    clearInterval(filePrune);
    await app.close();
    if (appsOrigin) await appsOrigin.close();
    await pool.end();
    await shutdownServerTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(`atrium surface server on http://${config.host}:${config.port} (workspace "${workspace.name}")`);
  if (appsOrigin) {
    await appsOrigin.listen({ port: config.appsPort, host: config.appsHost });
    console.log(`atrium apps origin on http://${config.appsHost}:${config.appsPort}`);
  }
}
