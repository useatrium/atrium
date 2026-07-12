import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../test-support/flaky-reporter';

export default defineConfig({
  test: {
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI ? ['default', new FlakyReporter('@atrium/surface-client')] : ['default'],
  },
});
