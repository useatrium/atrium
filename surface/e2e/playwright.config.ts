import { defineConfig, devices } from '@playwright/test';

// Playwright/pnpm force color in spawned Node processes; inheriting NO_COLOR at
// the same time makes Node 24 warn before every worker and webServer process.
delete process.env.NO_COLOR;

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
const centaurPort = Number(process.env.E2E_CENTAUR_PORT ?? 18100);
const webServerTimeout = Number(process.env.E2E_WEBSERVER_TIMEOUT ?? 60_000);
// CI serves the web app as a static development-mode build (`vite build
// --mode development` + `vite preview`) instead of the dev server. The dev
// server's on-demand transforms + dep optimizer eat a 2-vCPU runner for the
// first minute — the alphabetically-first spec lands on that cold path and
// blew its 60s test timeout in 3 of 3 recent runs — and every later page load
// keeps competing with tests for CPU. `--mode development` (not a prod build)
// keeps import.meta.env.DEV true, which the markup specs' editor hook needs;
// `vite preview` inherits server.proxy, so /api, /auth and /ws keep working.
// Local runs keep the dev server for fast iteration; override either way with
// E2E_WEB_SERVE=built|dev.
const builtWeb = (process.env.E2E_WEB_SERVE ?? (process.env.CI ? 'built' : 'dev')) === 'built';
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
  // The test timeout is a HANG detector, not a performance SLO — sized ~2x
  // the healthy p99 on a slow CI runner (the longest legit specs run 40-55s
  // there). At 60s, healthy-but-slow runs tipped over and each false fire
  // cost ~100s (60s burned + a ~40s retry), compounding toward the step
  // budget. Responsiveness is still policed by the expect timeout below: a
  // stuck assertion fails in 20s regardless. Local runs stay snappy.
  timeout: process.env.CI ? 120_000 : 30_000,
  expect: { timeout: process.env.CI ? 20_000 : 8_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
    // First attempts record no trace ('on-first-retry'); a failure screenshot
    // in test-results/ is the only artifact that shows what a first-attempt
    // timeout was looking at.
    screenshot: 'only-on-failure',
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
      command: builtWeb
        ? `pnpm --filter @atrium/web exec vite build --mode development && pnpm --filter @atrium/web exec vite preview --host 127.0.0.1 --port ${webPort} --strictPort`
        : `pnpm --filter @atrium/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      // The built path pays a one-time `vite build` before the port opens.
      timeout: builtWeb ? Math.max(webServerTimeout, 180_000) : webServerTimeout,
      env: {
        ATRIUM_API_TARGET: apiTarget,
        VITE_ATRIUM_WS_URL: `${apiTarget.replace(/^http/, 'ws')}/ws`,
        // A shell exporting NODE_ENV=production skews plugin-react on Vite 8:
        // the oxc refresh transform keys on `command === "serve"` but the
        // preamble injection keys on isProduction, so served modules reference
        // an undefined $RefreshSig$. Dev servers must run in development. The
        // built path needs it too: NODE_ENV=production would force
        // import.meta.env.DEV to false even under `--mode development`.
        NODE_ENV: 'development',
      },
    },
  ],
});
