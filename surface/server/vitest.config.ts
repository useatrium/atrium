import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../test-support/flaky-reporter';

const workerCount = Number.parseInt(process.env.ATRIUM_TEST_WORKERS ?? '3', 10);

export default defineConfig({
  test: {
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI ? ['default', new FlakyReporter('@atrium/server')] : ['default'],
    // server/test/helpers.ts derives one Postgres database per Vitest run+worker,
    // so file-level and process-level parallelism do not cross-truncate fixtures.
    fileParallelism: true,
    globalSetup: './test/globalSetup.ts',
    maxWorkers: Number.isFinite(workerCount) && workerCount > 0 ? workerCount : 3,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
