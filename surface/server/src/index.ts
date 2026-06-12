import { config } from './config.js';
import { createPool } from './db.js';
import { ensureDefaultWorkspace } from './events.js';
import { runMigrations } from './migrate.js';
import { WsHub } from './hub.js';
import { buildApp } from './app.js';
import { pruneIdempotencyKeys } from './idempotency.js';
import { pruneDraftTombstones } from './drafts.js';

async function main() {
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  await pruneIdempotencyKeys(pool);
  await pruneDraftTombstones(pool);
  const workspace = await ensureDefaultWorkspace(pool);
  const hub = new WsHub();
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
  const app = await buildApp({ pool, hub });

  const shutdown = async () => {
    clearInterval(heartbeat);
    clearInterval(idempotencyPrune);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `atrium surface server on http://${config.host}:${config.port} (workspace "${workspace.name}")`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
