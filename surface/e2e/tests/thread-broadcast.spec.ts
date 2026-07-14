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

  const mainReplyRow = confirmedRowsWithText(page, reply).first();
  await expect(mainReplyRow).toBeVisible();
  await expect(mainReplyRow).not.toHaveClass(/(^|\s)opacity-50(\s|$)/);
  await expect(mainReplyRow.getByRole('button', { name: /replied to a thread/ })).toBeVisible();

  await page.reload();
  await waitForChannel(page, room);

  const reloadedReplyRow = confirmedRowsWithText(page, reply).first();
  await expect(reloadedReplyRow).toBeVisible();
  await expect(reloadedReplyRow.getByRole('button', { name: /replied to a thread/ })).toBeVisible();

  const reloadedRootRow = confirmedRowsWithText(page, root).first();
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

  await page.getByLabel('Close thread').click();
  await expect(timelineText(page, reply)).toHaveCount(0);

  await page.reload();
  await waitForChannel(page, room);
  await expect(timelineText(page, reply)).toHaveCount(0);
});
