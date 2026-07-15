import { expect, test } from '@playwright/test';
import {
  apiAs,
  channelId,
  createTestChannel,
  distanceFromBottom,
  expectDividerInTimelineViewport,
  expectUnread,
  login,
  openChannel,
  readCursor,
  seedMessages,
  setReadCursor,
  unique,
  warmReaderCache,
} from './helpers.js';

test('read cursor persisted locally prevents first-unread relanding after refresh', async ({ page }) => {
  test.slow();
  const room = await createTestChannel('readcache');
  const readerHandle = unique('reader');
  const writer = await apiAs(unique('writer'), 'Writer');
  const reader = await apiAs(readerHandle, 'Reader');

  try {
    const roomId = await channelId(writer, room);
    const baselineIds = await seedMessages(writer, roomId, unique('baseline'), 18);
    const unreadIds = await seedMessages(writer, roomId, unique('unread'), 26);
    const latestId = unreadIds.at(-1)!;
    await setReadCursor({
      handle: readerHandle,
      channelId: roomId,
      lastReadEventId: baselineIds.at(-1)!,
    });

    await login(page, readerHandle, 'Reader');
    await expectUnread(page, room);
    await openChannel(page, room);

    const log = page.getByRole('log', { name: 'Messages' });
    const divider = page.locator('[data-unread-divider]');
    await expect(divider).toBeVisible({ timeout: 20_000 });
    await expectDividerInTimelineViewport(divider);

    await warmReaderCache({
      page,
      room,
      latestEventId: latestId,
      readCursor: () => readCursor({ handle: readerHandle, channelId: roomId }),
      confirmBottomAfterReload: false,
      cursorPollOptions: {
        intervals: [300, 700, 1000, 2000],
        timeout: 20_000,
      },
    });
    await expect(page.locator('[data-unread-divider]')).toHaveCount(0);
    await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  } finally {
    await writer.dispose();
    await reader.dispose();
  }
});
