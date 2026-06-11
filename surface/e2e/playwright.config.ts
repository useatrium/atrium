import { defineConfig, devices } from '@playwright/test';

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const baseURL = `http://127.0.0.1:${webPort}`;
const apiTarget = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `node db-reset.mjs && pnpm --filter @atrium/server dev`,
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
      },
    },
  ],
});
