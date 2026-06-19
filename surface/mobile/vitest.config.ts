import { defineConfig } from 'vitest/config';

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
    // React must run its development build for act()/Testing Library, even when
    // the invoking shell exports NODE_ENV=production (it does here). Mirrors the
    // web package's vitest config.
    env: { NODE_ENV: 'test' },
  },
});
