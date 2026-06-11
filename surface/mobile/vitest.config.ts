import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@atrium/centaur-client': new URL('../../packages/centaur-client/src/index.ts', import.meta.url).pathname,
    },
  },
});
