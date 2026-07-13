import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { FlakyReporter } from '../test-support/flaky-reporter';

const apiTarget = process.env.ATRIUM_API_TARGET ?? 'http://localhost:3001';
const wsTarget = apiTarget.replace(/^http/, 'ws');
// Optional Host override for the dev proxy: lets the local web point at a
// remote deployment through a host-routed reverse proxy (e.g. an SSH tunnel to
// its Caddy), which routes by Host header.
const proxyHost = process.env.ATRIUM_PROXY_HOST;
const proxyHeaders = proxyHost ? { headers: { host: proxyHost } } : {};
// Extra Host headers the dev server should answer (Vite blocks non-localhost
// hosts by default) — e.g. a Tailscale machine name when serving a demo over
// `tailscale serve`. Comma-separated.
const allowedHosts = (process.env.ATRIUM_DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // Linked workspace packages are consumed as TypeScript source; letting the
    // dep optimizer pre-bundle them serves a stale cached copy after their
    // source changes (bit us: codex transcript frames silently ignored).
    exclude: ['@atrium/centaur-client', '@atrium/surface-client'],
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom')) {
            return 'react';
          }
          if (id.includes('/node_modules/livekit-client') || id.includes('/node_modules/@livekit/')) {
            return 'livekit';
          }
          if (id.includes('/node_modules/')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI ? ['default', new FlakyReporter('@atrium/web')] : ['default'],
    // React must run its development build for act()/Testing Library, even if
    // the invoking shell exports NODE_ENV=production.
    env: { NODE_ENV: 'test' },
    setupFiles: ['./test/setup.ts'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
  },
  server: {
    port: 5173,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    fs: {
      // Allow serving @atrium/centaur-client and @atrium/surface-client
      // (linked from outside this root) and their test fixtures.
      allow: ['.', '../shared', '../centaur-client'],
    },
    proxy: {
      '/api': { target: apiTarget, ...proxyHeaders },
      '/auth': { target: apiTarget, ...proxyHeaders },
      '/ws': { target: wsTarget, ws: true, ...proxyHeaders },
    },
  },
});
