import { defineConfig, devices } from '@playwright/test';

// Playwright/pnpm force color in spawned Node processes; inheriting NO_COLOR at
// the same time makes Node 24 warn before every worker and webServer process.
delete process.env.NO_COLOR;

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
const centaurPort = Number(process.env.E2E_CENTAUR_PORT ?? 18100);
const webServerTimeout = Number(process.env.E2E_WEBSERVER_TIMEOUT ?? 60_000);
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const baseURL = `http://127.0.0.1:${webPort}`;
const apiTarget = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  testDir: './tests',
  // Tests isolate state via unique() handles/channels, so they tolerate
  // running concurrently against the one shared app + database. Two workers
  // roughly halves wall-clock; four also passed locally but provoked the Vite
  // WS proxy resets described below, so hold at two until repeated green runs.
  fullyParallel: true,
  workers: 2,
  // Generous on CI: shared runners are slow and variable, and the vite WS
  // proxy can reset a socket under load — the client recovers (reconnect →
  // channel refetch surfaces the missed unread) but needs more than a few
  // seconds. Local runs stay snappy via the lower timeouts.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 20_000 : 8_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // `start` (plain tsx), NOT `dev` (tsx watch): the watcher never exits and
      // Playwright's teardown can't reap it in CI (no TTY), hanging the job to
      // its timeout. e2e needs no hot reload.
      command: `node db-reset.mjs && pnpm --filter @atrium/server start`,
      url: `${apiTarget}/healthz`,
      reuseExistingServer: false,
      timeout: webServerTimeout,
      env: {
        DATABASE_URL: databaseUrl,
        E2E_SERVER_PORT: String(serverPort),
        E2E_WEB_PORT: String(webPort),
        PORT: String(serverPort),
        CENTAUR_BASE_URL: `http://127.0.0.1:${centaurPort}`,
        CENTAUR_API_KEY: 'e2e-centaur-key',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
        ATRIUM_RATE_LIMIT: '0',
        ARTIFACT_CAPTURE_API_KEY: 'e2e-capture-key',
      },
    },
    {
      command: `node centaur-stub.mjs`,
      url: `http://127.0.0.1:${centaurPort}/healthz`,
      reuseExistingServer: false,
      timeout: webServerTimeout,
      env: {
        PORT: String(centaurPort),
      },
    },
    {
      command: `pnpm --filter @atrium/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: webServerTimeout,
      env: {
        ATRIUM_API_TARGET: apiTarget,
        VITE_ATRIUM_WS_URL: `${apiTarget.replace(/^http/, 'ws')}/ws`,
        // A shell exporting NODE_ENV=production skews plugin-react on Vite 8:
        // the oxc refresh transform keys on `command === "serve"` but the
        // preamble injection keys on isProduction, so served modules reference
        // an undefined $RefreshSig$. Dev servers must run in development.
        NODE_ENV: 'development',
      },
    },
  ],
});
