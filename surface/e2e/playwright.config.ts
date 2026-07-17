import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { acquireMachineLock } from './machine-lock.js';

// Playwright/pnpm force color in spawned Node processes; inheriting NO_COLOR at
// the same time makes Node 24 warn before every worker and webServer process.
delete process.env.NO_COLOR;

// Ports and the database name are derived from THIS checkout's path, so two
// e2e runs in two worktrees cannot collide.
//
// They used to be fixed (3101/5273/18100) against one shared `atrium_e2e`
// database. On a box where several agent worktrees run e2e concurrently that
// is mutual destruction: whoever starts second either aborts on
// assertPortFree, or — if the ports happen to be free that instant — TRUNCATEs
// the shared database out from under the run already in flight. The victim
// then fails in scattered, unrelated places (unread badges, threads, read-sync)
// because its rows vanished mid-test, which reads exactly like flakiness and
// is not. It also bred a habit of `kill -9`ing whatever holds 3101, which just
// destroys the other worktree's run.
//
// A hash collision between two checkouts is still possible (100 slots); it
// surfaces as a loud assertPortFree error, not as silent corruption. Set
// E2E_PORT_OFFSET to break the tie. CI passes explicit env and is unaffected.
const checkoutId = createHash('sha1')
  .update(fileURLToPath(import.meta.url))
  .digest('hex')
  .slice(0, 8);
const portOffset = Number(process.env.E2E_PORT_OFFSET ?? Number.parseInt(checkoutId, 16) % 100);

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101 + portOffset);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273 + portOffset);
const centaurPort = Number(process.env.E2E_CENTAUR_PORT ?? 18100 + portOffset);

// Publish the resolved ports back into the environment. Test files compute
// their own apiURL/centaurStubUrl at import time from these vars (helpers.ts,
// mention-typeahead, markup-*, popout-pane) and fall back to the old fixed
// ports if they are unset — which, with derived ports, would silently aim a
// worker's API calls at a DIFFERENT worktree's server while its browser talked
// to ours. Playwright re-evaluates this config in each worker before loading
// test files, so assigning here reaches them.
process.env.E2E_SERVER_PORT = String(serverPort);
process.env.E2E_WEB_PORT = String(webPort);
process.env.E2E_CENTAUR_PORT = String(centaurPort);
const webServerTimeout = Number(process.env.E2E_WEBSERVER_TIMEOUT ?? 60_000);
// Same reason as the ports above: `seedArtifact` calls the node capture endpoint
// from a worker and must present the key the server was started with. Publishing
// it back keeps the two ends from drifting into an unexplained 401.
const captureApiKey = process.env.ARTIFACT_CAPTURE_API_KEY ?? 'e2e-capture-key';
process.env.ARTIFACT_CAPTURE_API_KEY = captureApiKey;
// The suite serves the web app as a static development-mode build (`vite build
// --mode development` + `vite preview`) rather than from the dev server. The dev
// server's on-demand transforms + dep optimizer compete with the tests for CPU on
// every page load, and that cost is what made the suite load-sensitive: measured
// under 4 concurrent suites, page-loading specs took 38-56s on the dev server and
// 4-5s built (API-only specs were fast either way — a clean fingerprint for who
// was to blame). Built is faster even on an idle box *including* the one-time
// build (2.4m vs 2.6m), so there is no iteration argument for keeping dev as the
// default.
//
// This used to be CI-only, which is backwards: CI is the *less* contended
// machine. A dev box also runs an agent fleet, so it needed the cheaper serving
// path more, not less.
//
// `--mode development` (not a prod build) keeps import.meta.env.DEV true, which
// the markup specs' editor hook needs; `vite preview` inherits server.proxy, so
// /api, /auth and /ws keep working. Set E2E_WEB_SERVE=dev to get the dev server
// back (HMR while iterating on a single spec).
const builtWeb = (process.env.E2E_WEB_SERVE ?? 'built') === 'built';
// Per-checkout database, for the same reason as the ports above: db-reset.mjs
// TRUNCATEs every table it owns, so a shared database means a concurrent run in
// another worktree wipes this one's data mid-test. Reused across runs of the
// same checkout (truncated, not dropped), so it stays cheap.
const databaseUrl = process.env.E2E_DATABASE_URL ?? `postgres://atrium:atrium@localhost:5433/atrium_e2e_${checkoutId}`;
// Same reason as the ports: helpers.ts reads E2E_DATABASE_URL at import time to
// query Postgres directly (read cursors, etc.). Unset, it would fall back to the
// old shared `atrium_e2e` and read a different database than the server writes.
process.env.E2E_DATABASE_URL = databaseUrl;
const baseURL = `http://127.0.0.1:${webPort}`;
const apiTarget = `http://127.0.0.1:${serverPort}`;

// One e2e suite at a time per machine. Awaited here, at config scope, because
// this is the only hook every entry point shares AND it runs before `webServer`:
// an npm-script wrapper only guarded `pnpm e2e`, so `pnpm exec playwright test
// <spec>` — which is how agents run targeted specs — walked straight past it and
// starved whoever held the machine. No-ops in workers and on CI (see the module).
await acquireMachineLock();

export default defineConfig({
  testDir: './tests',
  // Tests isolate state via unique() handles/channels, so they tolerate
  // running concurrently against the one shared app + database. Two workers
  // roughly halves wall-clock; four also passed locally but provoked the Vite
  // WS proxy resets described below, so hold at two until repeated green runs.
  fullyParallel: true,
  workers: 2,
  // Both timeouts below are HANG detectors, not performance SLOs.
  //
  // The test timeout is sized ~2x the healthy p99 on a slow CI runner (the
  // longest legit specs run 40-55s there). At 60s, healthy-but-slow runs
  // tipped over and each false fire cost ~100s (60s burned + a ~40s retry),
  // compounding toward the step budget.
  //
  // The expect timeout is deliberately NOT forked by CI. It used to be 8s
  // locally vs 20s on CI, which made local runs *stricter* than CI on a
  // machine that is *more* loaded (parallel agent worktrees, other vitest
  // runs, and a Vite dev server transforming on demand under that same CPU
  // pressure). Load-sensitive assertions therefore failed locally that CI
  // would never flag, and each one got patched with an ad-hoc per-assertion
  // bump — 34 of them accumulated, and because they are absolute they also
  // silently *tightened* CI below its own 20s base. A tight budget buys
  // nothing: a real logic bug fails at 8s and at 20s alike, and a genuine
  // hang is still caught by the test timeout. So there is one budget, and
  // assertions inherit it instead of hand-tuning. Override with
  // E2E_EXPECT_TIMEOUT if you want a tighter local loop.
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: Number(process.env.E2E_EXPECT_TIMEOUT ?? 20_000) },
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
        ATRIUM_UNFURL_ALLOW_PRIVATE: '1',
        ARTIFACT_CAPTURE_API_KEY: captureApiKey,
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
