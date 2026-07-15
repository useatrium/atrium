import { expect, test, type Page } from '@playwright/test';
import {
  channelId,
  confirmedRowsWithText,
  createTestChannel,
  injectSession,
  login,
  messageRow,
  openChannel,
  unique,
} from './helpers.js';

function threadPanel(page: Page) {
  return page.locator('aside').filter({ has: page.getByLabel('Close thread') });
}

test('an attached thread can round-trip through aside mode without steering the agent', async ({ page }) => {
  const room = await createTestChannel('spine-aside');
  const handle = unique('aside-author');
  await login(page, handle, 'Aside Author');
  const roomId = await channelId(page.context().request, room);
  const title = unique('attached-session');
  const { sessionId } = await injectSession({ handle, channelId: roomId, title });
  const sessionPosts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new RegExp(`/api/sessions/${sessionId}/(?:messages|suggestions)$`).test(request.url())
    ) {
      sessionPosts.push(request.url());
    }
  });
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: '',
    });
  });
  await openChannel(page, room);
  await page.reload();

  const root = messageRow(page, title);
  await expect(root).toBeVisible();
  await root.getByRole('button', { name: 'Open thread →' }).click();
  const thread = threadPanel(page);
  const input = thread.getByLabel('Message input');
  const pill = thread.getByTestId('composer-audience-pill');
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(pill).toContainText('Steer');
  await expect(thread.getByText('Goes to the agent · Esc for an aside', { exact: true })).toBeVisible();

  await input.press('Escape');
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await expect(pill).toContainText('Aside');
  await expect(thread.getByText('Aside — visible to people, never sent to the agent', { exact: true })).toBeVisible();

  const aside = unique('people-only-aside');
  await input.fill(aside);
  await input.press('Enter');
  await expect(thread.getByTestId('aside-row').filter({ hasText: aside })).toBeVisible();
  await expect(confirmedRowsWithText(page, aside)).toHaveCount(0);
  await expect(thread.getByTestId('user-steer')).toHaveCount(0);
  expect(sessionPosts).toEqual([]);

  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(pill).toContainText('Steer');
  await expect(thread.getByText('Goes to the agent · Esc for an aside', { exact: true })).toBeVisible();
});
