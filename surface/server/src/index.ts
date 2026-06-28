import { initServerTelemetry, shutdownServerTelemetry } from './telemetry.js';

await initServerTelemetry();
const { main } = await import('./main.js');

main().catch(async (err) => {
  console.error(err);
  await shutdownServerTelemetry();
  process.exit(1);
});
