import { expect, test, type Page } from '@playwright/test';
import {
  confirmedRowsWithText,
  createTestChannel,
  login,
  messageRow,
  openChannel,
  sendMessage,
  timelineText,
  unique,
} from './helpers.js';

async function waitForChannel(page: Page, channelName: string): Promise<void> {
  await expect(page.getByRole('heading', { name: `# ${channelName}` })).toBeVisible();
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
}

async function openThreadForMessage(page: Page, text: string): Promise<void> {
  const row = messageRow(page, text);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
}

async function sendThreadReply(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('Reply…').fill(text);
  await page.getByPlaceholder('Reply…').press('Enter');
}

function threadPanel(page: Page) {
  return page.locator('aside').filter({ has: page.getByLabel('Close thread') });
}

test('broadcast reply lands confirmed in the channel and survives reload', async ({ page }) => {
  const room = await createTestChannel('thread-broadcast');
  await login(page, unique('broadcaster'), 'Broadcaster');
  await openChannel(page, room);

  const root = unique('broadcast-root');
  const reply = unique('broadcast-reply');
  await sendMessage(page, root, room);

  await openThreadForMessage(page, root);
  await page.getByRole('checkbox', { name: /also send to channel/i }).check();
  await sendThreadReply(page, reply);

  // The broadcast reply anchors under its root as part of the annotation
  // cluster — no standalone channel row, no "replied to a thread" backlink.
  const rootRow = confirmedRowsWithText(page, root).first();
  await expect(rootRow.getByTestId('channel-annotation-cluster').getByText(reply, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /replied to a thread/ })).toHaveCount(0);

  await page.reload();
  await waitForChannel(page, room);

  const reloadedRootRow = confirmedRowsWithText(page, root).first();
  await expect(
    reloadedRootRow.getByTestId('channel-annotation-cluster').getByText(reply, { exact: true }),
  ).toBeVisible();
  await expect(reloadedRootRow.getByRole('button', { name: 'Open thread →' })).toBeVisible();
});

test('non-broadcast thread reply stays out of the channel', async ({ page }) => {
  const room = await createTestChannel('thread-private');
  await login(page, unique('threader'), 'Threader');
  await openChannel(page, room);

  const root = unique('private-root');
  const reply = unique('private-reply');
  await sendMessage(page, root, room);

  await openThreadForMessage(page, root);
  await sendThreadReply(page, reply);

  const confirmedThreadReply = threadPanel(page).locator('[data-eid]').filter({ hasText: reply });
  await expect(confirmedThreadReply).toBeVisible();

  // A non-broadcast reply never becomes its own channel row. It IS allowed to
  // surface as the root's collapsed-cluster preview (the universal thread
  // cluster shows every thread's latest reply) — so assert containment, not
  // absence: every match lives inside the root's row.
  await page.getByLabel('Close thread').click();
  const rootRow = confirmedRowsWithText(page, root).first();
  await expect(rootRow.getByTestId('channel-annotation-cluster').getByText(reply, { exact: true })).toBeVisible();
  await expect(confirmedRowsWithText(page, reply)).toHaveCount(1); // the root row only

  await page.reload();
  await waitForChannel(page, room);
  const reloadedRootRow = confirmedRowsWithText(page, root).first();
  await expect(
    reloadedRootRow.getByTestId('channel-annotation-cluster').getByText(reply, { exact: true }),
  ).toBeVisible();
  await expect(confirmedRowsWithText(page, reply)).toHaveCount(1);
});
