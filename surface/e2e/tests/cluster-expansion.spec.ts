import { expect, test, type Page } from '@playwright/test';
import {
  confirmedRowsWithText,
  createTestChannel,
  login,
  messageRow,
  openChannel,
  sendMessage,
  unique,
} from './helpers.js';

async function openThread(page: Page, root: string): Promise<void> {
  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
}

async function reply(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('Reply…');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('aside').getByText(text, { exact: true })).toBeVisible();
}

test('collapsed thread cluster expands and collapses earlier replies inline', async ({ page }) => {
  const room = await createTestChannel('cluster-expand');
  await login(page, unique('clusterer'), 'Clusterer');
  await openChannel(page, room);

  const root = unique('cluster-root');
  const first = unique('cluster-first');
  const second = unique('cluster-second');
  const latest = unique('cluster-latest');
  await sendMessage(page, root, room);
  await openThread(page, root);
  await reply(page, first);
  await reply(page, second);
  await reply(page, latest);
  await page.getByLabel('Close thread').click();

  const rootRow = confirmedRowsWithText(page, root).first();
  const cluster = rootRow.getByTestId('channel-annotation-cluster');
  await expect(cluster.getByText(latest, { exact: true })).toBeVisible();
  await expect(cluster.getByRole('button', { name: '▶ 2 earlier replies' })).toBeVisible();
  await expect(cluster.getByRole('button', { name: 'Open thread →' })).toBeVisible();

  await cluster.getByRole('button', { name: '▶ 2 earlier replies' }).click();
  await expect(cluster.getByRole('button', { name: '▼ 2 earlier replies' })).toBeVisible();
  await expect(cluster.getByTestId('thread-compact-reply').filter({ hasText: first })).toBeVisible();
  await expect(cluster.getByTestId('thread-compact-reply').filter({ hasText: second })).toBeVisible();
  await expect(page.getByLabel('Close thread')).toHaveCount(0);

  await cluster.getByRole('button', { name: '▼ 2 earlier replies' }).click();
  await expect(cluster.getByTestId('thread-compact-reply').filter({ hasText: first })).toHaveCount(0);
  await expect(cluster.getByTestId('thread-compact-reply').filter({ hasText: second })).toHaveCount(0);
  await expect(cluster.getByText(latest, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  const reloadedCluster = confirmedRowsWithText(page, root).first().getByTestId('channel-annotation-cluster');
  await expect(reloadedCluster.getByText(latest, { exact: true })).toBeVisible();
  await expect(reloadedCluster.getByRole('button', { name: '▶ 2 earlier replies' })).toBeVisible();
});
