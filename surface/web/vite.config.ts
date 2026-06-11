import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.ATRIUM_API_TARGET ?? 'http://localhost:3001';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // React must run its development build for act()/Testing Library, even if
    // the invoking shell exports NODE_ENV=production.
    env: { NODE_ENV: 'test' },
  },
  server: {
    port: 5173,
    fs: {
      // Allow serving @atrium/centaur-client and @atrium/surface-client
      // (linked from outside this root) and their test fixtures.
      allow: ['.', '../shared', '../../packages/centaur-client'],
    },
    proxy: {
      '/api': apiTarget,
      '/auth': apiTarget,
      '/ws': { target: wsTarget, ws: true },
    },
  },
});
