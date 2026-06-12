import { defineConfig, devices } from '@playwright/test';

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
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
      timeout: 60_000,
      env: {
        DATABASE_URL: databaseUrl,
        E2E_SERVER_PORT: String(serverPort),
        E2E_WEB_PORT: String(webPort),
        PORT: String(serverPort),
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
      },
    },
    {
      command: `pnpm --filter @atrium/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ATRIUM_API_TARGET: apiTarget,
        // A shell exporting NODE_ENV=production skews plugin-react on Vite 8:
        // the oxc refresh transform keys on `command === "serve"` but the
        // preamble injection keys on isProduction, so served modules reference
        // an undefined $RefreshSig$. Dev servers must run in development.
        NODE_ENV: 'development',
      },
    },
  ],
});
