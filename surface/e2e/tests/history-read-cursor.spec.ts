import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiAs, channelId, createTestChannel, login, openChannel, postMessage, unique } from './helpers.js';

async function seedTallMessages(
  ctx: APIRequestContext,
  channelIdValue: string,
  prefix: string,
  count: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const text = `${prefix} ${index} ${'viewport-filling message content '.repeat(40)}`;
    ids.push(await postMessage(ctx, channelIdValue, text));
  }
  return ids;
}

async function distanceFromBottom(log: Locator): Promise<number> {
  return log.evaluate((node) => {
    const element = node as HTMLElement;
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  });
}

async function dividerOffsetFromViewportTop(divider: Locator): Promise<number> {
  return divider.evaluate((node) => {
    const scroller = node.closest('[role="log"]');
    if (!scroller) return Number.POSITIVE_INFINITY;
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

async function warmReaderCache(args: {
  page: Page;
  room: string;
  roomId: string;
  readerHandle: string;
  readerSession: APIRequestContext;
  latestBaselineId: number;
}): Promise<string> {
  await login(args.page, args.readerHandle, 'Reader');
  await openChannel(args.page, args.room);

  const log = args.page.getByRole('log', { name: 'Messages' });
  const latestRow = log.locator(`[data-eid="${args.latestBaselineId}"]`);
  await latestRow.scrollIntoViewIfNeeded();
  await expect(latestRow).toBeVisible();
  await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  await expect
    .poll(
      async () => {
        const response = await args.readerSession.get(`/api/channels/${args.roomId}/messages?limit=1`);
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { readCursor?: number }).readCursor ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(args.latestBaselineId);

  const route = args.page.url();
  await args.page.reload();
  await expect(args.page.getByRole('heading', { name: `# ${args.room}` })).toBeVisible();
  await expect(log.locator(`[data-eid="${args.latestBaselineId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  return route;
}

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
    const baselineIds = await seedTallMessages(writer, roomId, unique('baseline'), 18);
    const route = await warmReaderCache({
      page,
      room,
      roomId,
      readerHandle,
      readerSession: initialReaderSession,
      latestBaselineId: baselineIds.at(-1)!,
    });
    await page.close();

    const newIds = await seedTallMessages(initialReaderSession, roomId, unique('remote-read'), 14);
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
    const baselineIds = await seedTallMessages(writer, roomId, unique('baseline'), 18);
    const latestBaselineId = baselineIds.at(-1)!;
    const route = await warmReaderCache({
      page,
      room,
      roomId,
      readerHandle,
      readerSession: secondReaderSession,
      latestBaselineId,
    });
    await page.close();

    const newIds = await seedTallMessages(writer, roomId, unique('genuine-unread'), 14);
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
