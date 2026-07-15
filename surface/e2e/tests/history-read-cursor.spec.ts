import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  apiAs,
  channelId,
  createTestChannel,
  distanceFromBottom,
  dividerOffsetFromViewportTop,
  login,
  openChannel,
  seedMessages,
  unique,
  warmReaderCache,
} from './helpers.js';

function trackHistoryReadCursors(page: Page, roomId: string): number[] {
  const cursors: number[] = [];
  page.on('response', async (response) => {
    if (!response.ok() || !response.url().includes(`/api/channels/${roomId}/messages`)) return;
    try {
      const body = (await response.json()) as { readCursor?: unknown };
      if (typeof body.readCursor === 'number') cursors.push(body.readCursor);
    } catch {
      // Navigation can dispose an intercepted response body; another history
      // response will still provide the cursor this assertion is waiting for.
    }
  });
  return cursors;
}

async function reopenChannel(context: BrowserContext, route: string, room: string, roomId: string) {
  const page = await context.newPage();
  const historyReadCursors = trackHistoryReadCursors(page, roomId);
  await page.goto(route);
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  return { page, historyReadCursors };
}

test('history readCursor prevents a stale cached unread-divider landing after another session reads', async ({
  page,
  context,
}) => {
  test.slow();
  const room = await createTestChannel('history-read');
  const readerHandle = unique('reader');
  const writer = await apiAs(unique('writer'), 'Writer');
  const initialReaderSession = await apiAs(readerHandle, 'Reader');

  try {
    const roomId = await channelId(writer, room);
    const baselineIds = await seedMessages(writer, roomId, unique('baseline'), 18, {
      text: (index, prefix) => `${prefix} ${index} ${'viewport-filling message content '.repeat(40)}`,
    });
    await login(page, readerHandle, 'Reader');
    await openChannel(page, room);
    const route = await warmReaderCache({
      page,
      room,
      latestEventId: baselineIds.at(-1)!,
      confirmBottomBeforeCursor: true,
      readCursor: async () => {
        const response = await initialReaderSession.get(`/api/channels/${roomId}/messages?limit=1`);
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { readCursor?: number }).readCursor ?? 0;
      },
      cursorPollOptions: { timeout: 20_000 },
    });
    await page.close();

    const newIds = await seedMessages(initialReaderSession, roomId, unique('remote-read'), 14, {
      text: (index, prefix) => `${prefix} ${index} ${'viewport-filling message content '.repeat(40)}`,
    });
    const newestId = newIds.at(-1)!;
    const marked = await initialReaderSession.post(`/api/channels/${roomId}/read`, {
      data: { lastReadEventId: newestId },
    });
    expect(marked.ok(), `POST read cursor (${marked.status()})`).toBeTruthy();

    const reopened = await reopenChannel(context, route, room, roomId);
    await expect.poll(() => reopened.historyReadCursors.includes(newestId), { timeout: 20_000 }).toBe(true);
    const log = reopened.page.getByRole('log', { name: 'Messages' });
    await expect(log.locator(`[data-eid="${newestId}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(reopened.page.locator('[data-unread-divider]')).toHaveCount(0);
    await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  } finally {
    await writer.dispose();
    await initialReaderSession.dispose();
  }
});

test('history readCursor preserves a genuine unread-divider landing', async ({ page, context }) => {
  test.slow();
  const room = await createTestChannel('history-unread');
  const readerHandle = unique('reader');
  const writer = await apiAs(unique('writer'), 'Writer');
  const secondReaderSession = await apiAs(readerHandle, 'Reader');

  try {
    const roomId = await channelId(writer, room);
    const baselineIds = await seedMessages(writer, roomId, unique('baseline'), 18, {
      text: (index, prefix) => `${prefix} ${index} ${'viewport-filling message content '.repeat(40)}`,
    });
    const latestBaselineId = baselineIds.at(-1)!;
    await login(page, readerHandle, 'Reader');
    await openChannel(page, room);
    const route = await warmReaderCache({
      page,
      room,
      latestEventId: latestBaselineId,
      confirmBottomBeforeCursor: true,
      readCursor: async () => {
        const response = await secondReaderSession.get(`/api/channels/${roomId}/messages?limit=1`);
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { readCursor?: number }).readCursor ?? 0;
      },
      cursorPollOptions: { timeout: 20_000 },
    });
    await page.close();

    const newIds = await seedMessages(writer, roomId, unique('genuine-unread'), 14, {
      text: (index, prefix) => `${prefix} ${index} ${'viewport-filling message content '.repeat(40)}`,
    });
    const newestId = newIds.at(-1)!;

    const reopened = await reopenChannel(context, route, room, roomId);
    await expect.poll(() => reopened.historyReadCursors.includes(latestBaselineId), { timeout: 20_000 }).toBe(true);
    await expect(reopened.page.getByRole('log', { name: 'Messages' }).locator(`[data-eid="${newestId}"]`)).toHaveCount(
      1,
    );
    const divider = reopened.page.locator('[data-unread-divider]');
    await expect(divider).toHaveCount(1);
    await expect.poll(() => dividerOffsetFromViewportTop(divider), { timeout: 20_000 }).toBeGreaterThanOrEqual(-2);
    await expect.poll(() => dividerOffsetFromViewportTop(divider), { timeout: 20_000 }).toBeLessThan(120);
  } finally {
    await writer.dispose();
    await secondReaderSession.dispose();
  }
});
