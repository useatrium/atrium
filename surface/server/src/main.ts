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
import { deleteObject } from './s3.js';
import { startArtifactGcWorker, type ArtifactGcWorker } from './artifact-ledger-gc.js';
import { SttWorker } from './stt/worker.js';
import { registerWhisperCppAdapter } from './stt/whispercpp.js';
import { shutdownServerTelemetry } from './telemetry.js';

export async function main() {
  if ((process.env.STT_PROVIDER ?? 'noop') === 'whispercpp') {
    registerWhisperCppAdapter();
  }
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  await pruneIdempotencyKeys(pool);
  await pruneDraftTombstones(pool);
  await pruneOrphanFiles(pool, { deleteObject }).catch((err) => {
    console.warn('orphan file prune failed', err);
  });
  const workspace = await ensureDefaultWorkspace(pool);
  const hub = new WsHub();
  const sttWorker = new SttWorker({ pool, hub });
  await sttWorker.sweepOnBoot();
  const heartbeat = hub.startHeartbeat(30_000);
  const idempotencyPrune = setInterval(() => {
    void pruneIdempotencyKeys(pool).catch((err) => {
      console.warn('idempotency prune failed', err);
    });
    void pruneDraftTombstones(pool).catch((err) => {
      console.warn('draft tombstone prune failed', err);
    });
  }, 24 * 60 * 60 * 1000);
  idempotencyPrune.unref?.();
  const filePrune = setInterval(() => {
    void pruneOrphanFiles(pool, { deleteObject }).catch((err) => {
      console.warn('orphan file prune failed', err);
    });
  }, 24 * 60 * 60 * 1000);
  filePrune.unref?.();
  const rateLimit = config.rateLimitEnabled
    ? { max: config.rateLimitMax, loginMax: config.rateLimitLoginMax }
    : false;
  const app = await buildApp({ pool, hub, stt: sttWorker, rateLimit });
  const appsOrigin = config.appsPort > 0 ? await buildAppsOrigin({ pool }) : null;

  // === gc additions ===
  let artifactGc: ArtifactGcWorker | null = null;
  if (config.artifactGcEnabled) {
    artifactGc = startArtifactGcWorker({ pool, storage: { deleteObject } });
  }

  const shutdown = async () => {
    sttWorker.stop();
    artifactGc?.stop();
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
  console.log(
    `atrium surface server on http://${config.host}:${config.port} (workspace "${workspace.name}")`,
  );
  if (appsOrigin) {
    await appsOrigin.listen({ port: config.appsPort, host: config.appsHost });
    console.log(`atrium apps origin on http://${config.appsHost}:${config.appsPort}`);
  }
}
