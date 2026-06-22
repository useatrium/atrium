import { defineConfig } from 'vitest/config';

const workerCount = Number.parseInt(process.env.ATRIUM_TEST_WORKERS ?? '3', 10);

export default defineConfig({
  test: {
    // server/test/helpers.ts derives one Postgres database per Vitest worker,
    // so file-level parallelism no longer cross-truncates fixtures.
    fileParallelism: true,
    maxWorkers: Number.isFinite(workerCount) && workerCount > 0 ? workerCount : 3,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
