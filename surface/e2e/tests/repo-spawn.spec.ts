import { expect, test } from '@playwright/test';
import { login, unique } from './helpers.js';

test('configured spawn posts working and reference repo specs', async ({ page }) => {
  await login(page, unique('repoer'), 'Repo Tester');

  let spawnBody: unknown;
  await page.route('**/api/sessions', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    spawnBody = req.postDataJSON();
    const body = spawnBody as {
      channelId: string;
      task: string;
      harness: string;
      repo?: string;
      branch?: string;
      repos?: Array<{ repo: string; ref?: string; subdir?: string }>;
    };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: `sess-${unique('repo')}`,
          workspaceId: 'workspace-e2e',
          channelId: body.channelId,
          threadRootEventId: null,
          title: body.task,
          status: 'spawning',
          harness: body.harness,
          repo: body.repo ?? null,
          branch: body.branch ?? null,
          repos: body.repos ?? null,
          spawnedBy: 'repoer-e2e',
          driverId: null,
          costUsd: null,
          resultText: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          lastEventId: 0,
          permalink: '/s/repo-spawn-e2e',
        },
      }),
    });
  });

  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(page.getByRole('dialog', { name: 'Start an agent session' })).toBeVisible();
  await page.getByPlaceholder('What should the agent do?').fill('inspect repo wiring');
  await page.getByPlaceholder('owner/name').fill(' acme/app ');
  await page.getByPlaceholder('main').fill(' dev ');
  await page.getByRole('button', { name: 'Add reference repo' }).click();
  await page.getByPlaceholder('owner/name').nth(1).fill(' acme/docs ');
  await page.getByPlaceholder('ref').fill(' docs-main ');
  await page.getByPlaceholder('subdir').fill(' docs ');

  await expect(page.getByText('Working repo + 1 reference repo')).toBeVisible();
  await expect(page.getByText('mounts under ~/repos')).toBeVisible();

  await page.getByRole('button', { name: 'Start session' }).click();
  await expect.poll(() => spawnBody).toBeTruthy();
  expect(spawnBody).toMatchObject({
    task: 'inspect repo wiring',
    harness: 'codex',
    repo: 'acme/app',
    branch: 'dev',
    repos: [
      { repo: 'acme/app', ref: 'dev' },
      { repo: 'acme/docs', ref: 'docs-main', subdir: 'docs' },
    ],
  });
});

test('configured spawn posts private repo flags and GitHub identity override', async ({ page }) => {
  await page.route('**/api/me/connections', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connections: [
          {
            provider: 'github',
            id: 'github:app_installation:12345',
            workspaceId: 'workspace-e2e',
            connected: true,
            status: 'connected',
            tokenKind: 'app_installation',
            accountLogin: 'acme',
            accountLabel: 'acme',
            scopes: [],
            capabilities: {},
            metadata: {},
            identities: [
              {
                id: 'github:app_installation:12345',
                provider: 'github',
                workspaceId: 'workspace-e2e',
                active: true,
                connected: true,
                status: 'connected',
                tokenKind: 'app_installation',
                accountLogin: 'acme',
                accountLabel: 'acme',
                scopes: [],
                capabilities: {},
                metadata: { installationId: '12345' },
                lastValidatedAt: null,
                lastError: null,
                updatedAt: new Date().toISOString(),
              },
            ],
            lastValidatedAt: new Date().toISOString(),
            lastError: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });
  await login(page, unique('repoer-private'), 'Repo Private Tester');

  let spawnBody: unknown;
  await page.route('**/api/sessions', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    spawnBody = req.postDataJSON();
    const body = spawnBody as {
      channelId: string;
      task: string;
      harness: string;
      repo?: string;
      branch?: string;
      repos?: Array<{ repo: string; ref?: string; subdir?: string; private?: boolean }>;
      githubIdentityMode?: string;
      githubIdentityId?: string;
    };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: `sess-${unique('repo-private')}`,
          workspaceId: 'workspace-e2e',
          channelId: body.channelId,
          threadRootEventId: null,
          title: body.task,
          status: 'spawning',
          harness: body.harness,
          repo: body.repo ?? null,
          branch: body.branch ?? null,
          repos: body.repos ?? null,
          githubIdentityMode: body.githubIdentityMode ?? 'automatic',
          providerConnectionId: body.githubIdentityId ?? null,
          spawnedBy: 'repoer-private-e2e',
          driverId: null,
          costUsd: null,
          resultText: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          lastEventId: 0,
          permalink: '/s/repo-private-spawn-e2e',
        },
      }),
    });
  });

  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByPlaceholder('What should the agent do?').fill('inspect private repo wiring');
  await page.getByPlaceholder('owner/name').fill(' acme/private ');
  await page.getByRole('checkbox', { name: 'Private repo' }).check();
  await page.getByRole('button', { name: 'Add reference repo' }).click();
  await page.getByPlaceholder('owner/name').nth(1).fill(' acme/private-docs ');
  await page.getByRole('checkbox', { name: 'Private', exact: true }).check();
  await page.getByLabel(/GitHub identity/).selectOption('github:app_installation:12345');

  await expect(page.getByText('GitHub: app install for acme')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect.poll(() => spawnBody).toBeTruthy();
  expect(spawnBody).toMatchObject({
    task: 'inspect private repo wiring',
    harness: 'codex',
    repo: 'acme/private',
    githubIdentityMode: 'app_installation',
    githubIdentityId: 'github:app_installation:12345',
    repos: [
      { repo: 'acme/private', private: true },
      { repo: 'acme/private-docs', private: true },
    ],
  });
});

test('configured spawn blocks private repos until GitHub is connected', async ({ page }) => {
  await page.route('**/api/me/connections', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connections: [] }),
    });
  });
  await login(page, unique('repoer-blocked'), 'Repo Blocked Tester');

  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByPlaceholder('What should the agent do?').fill('inspect private repo');
  await page.getByPlaceholder('owner/name').fill(' acme/private ');
  await page.getByRole('checkbox', { name: 'Private repo' }).check();

  await expect(page.getByText('Connect GitHub before starting a session with private repositories.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();

  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByRole('dialog', { name: 'GitHub connection' })).toBeVisible();
});
