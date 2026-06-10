import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one Postgres test database (atrium_test) and truncate
    // between cases — run files serially to avoid cross-file interference.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
