import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../test-support/flaky-reporter';

export default defineConfig({
  test: {
    // Main-process unit tests only — e2e/*.spec.ts is Playwright's, not vitest's.
    include: ['src/main/**/*.test.ts'],
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI ? ['default', new FlakyReporter('@atrium/desktop')] : ['default'],
  },
});
