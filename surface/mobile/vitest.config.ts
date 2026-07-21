import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../test-support/flaky-reporter';

// Component tests render React Native components through react-native-web in
// jsdom (opt in per file with `// @vitest-environment jsdom`), giving web-style
// Testing Library queries without RN's Flow-typed source. Pure-lib tests
// (sessionStream, cache, …) keep the default node environment — they don't
// import 'react-native', so the alias below is a no-op for them.
export default defineConfig({
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
  },
  test: {
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI ? ['default', new FlakyReporter('@atrium/mobile')] : ['default'],
    // Cap jsdom concurrency so full-workspace test load cannot cause
    // CPU-starvation flakes. Mirrors the web package's cap — mobile was the one
    // heavy jsdom suite left uncapped, so it oversubscribed a shared runner.
    maxWorkers: Number(process.env.ATRIUM_TEST_WORKERS ?? 3),
    // React must run its development build for act()/Testing Library, even when
    // the invoking shell exports NODE_ENV=production (it does here). Mirrors the
    // web package's vitest config.
    env: { NODE_ENV: 'test' },
  },
});
