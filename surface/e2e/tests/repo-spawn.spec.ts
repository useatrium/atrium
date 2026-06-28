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
