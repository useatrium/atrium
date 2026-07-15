import { expect, test } from '@playwright/test';
import {
  apiAs,
  channelButton,
  channelId,
  createTestChannel,
  distanceFromBottom,
  expectDividerInTimelineViewport,
  expectRead,
  expectUnread,
  login,
  openChannel,
  readCursor,
  scrollToBottom,
  seedMessages,
  setReadCursor,
  unique,
} from './helpers.js';

/**
 * Live sidebar unread marker WITHOUT `expectUnread`'s reload fallback — a reload
 * re-derives unread from the server and would mask an in-session badge bug.
 */
function liveUnreadMarker(page: Parameters<typeof channelButton>[0], channelName: string) {
  return channelButton(page, channelName)
    .locator('span.sr-only')
    .filter({ hasText: /^unread$/ });
}

test('channel read position lands on first unread and marks read only at bottom', async ({ page }) => {
  // No test.slow(): with lean seeding and no reloads this runs well inside
  // the CI hang-detector budget, and slow()'s 3x would let a real hang
  // (x retries) outlast the workflow step budget.
  const unreadRoom = await createTestChannel('readpos');
  const parkingRoom = await createTestChannel('readpos-read');
  const readerHandle = unique('reader');
  const writer = await apiAs(unique('writer'), 'Writer');
  const reader = await apiAs(readerHandle, 'Reader');

  try {
    const unreadRoomId = await channelId(writer, unreadRoom);
    const baselineIds = await seedMessages(writer, unreadRoomId, unique('baseline'), 18, { parallel: true });
    const unreadIds = await seedMessages(writer, unreadRoomId, unique('unread'), 24, { parallel: true });
    const baselineId = Math.max(...baselineIds);
    const newestUnreadId = Math.max(...unreadIds);
    await setReadCursor({
      handle: readerHandle,
      channelId: unreadRoomId,
      lastReadEventId: baselineId,
    });

    await login(page, readerHandle, 'Reader');

    await expectUnread(page, unreadRoom);
    await openChannel(page, unreadRoom);

    const log = page.getByRole('log', { name: 'Messages' });
    const divider = page.locator('[data-unread-divider]');
    await expect(divider).toBeVisible();
    await expectDividerInTimelineViewport(divider);
    // Landed on the divider, not the bottom — there is unread content below it.
    // Generous timeout: cold-load landing waits for the initial sync to settle
    // and the divider to freeze, which is slow on a loaded CI runner.
    await expect.poll(async () => distanceFromBottom(log), { timeout: 20_000 }).toBeGreaterThan(80);
    // Away from the bottom, the jump pill must offer a way down — this is the
    // suite's only coverage of it, so it stays even though it's incidental to
    // the cursor story.
    await expect(page.getByTestId('jump-to-latest')).toBeVisible();

    // Leave the partially-read channel WITHOUT scrolling to the bottom. Its
    // sidebar badge must stay unread in-session (no reload) — select-channel
    // optimistically cleared it, so the switch has to re-derive from the cursor.
    await openChannel(page, parkingRoom);
    await expect(liveUnreadMarker(page, unreadRoom)).toHaveCount(1, { timeout: 4000 });
    // Merely entering and leaving the channel must not advance the persisted
    // cursor. This checks the server state directly without a full-app reload.
    expect(await readCursor({ handle: readerHandle, channelId: unreadRoomId })).toBe(baselineId);

    await openChannel(page, unreadRoom);
    const reopenedLog = page.getByRole('log', { name: 'Messages' });
    // Reopening lands on the divider again (still unread). Wait for that initial
    // landing to settle first — otherwise a late landing (slow CI) would revert
    // the scroll below and mark-read would never fire.
    const reopenedDivider = page.locator('[data-unread-divider]');
    await expect(reopenedDivider).toBeVisible({ timeout: 20_000 });
    await expectDividerInTimelineViewport(reopenedDivider);
    // Now scroll to the bottom → the read watermark advances to the newest
    // message. Re-scroll on each poll so any stray re-render can't strand us.
    await expect
      .poll(
        async () => {
          await scrollToBottom(reopenedLog);
          return readCursor({ handle: readerHandle, channelId: unreadRoomId });
        },
        // Mark-read is a client→server round-trip after the scroll lands; under
        // heavy parallel CI load its propagation is the slowest step here, so
        // give it more patience than the other polls.
        { intervals: [500, 1000, 1000, 2000, 3000], timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(newestUnreadId);

    await openChannel(page, parkingRoom);
    await expectRead(page, unreadRoom);
  } finally {
    await writer.dispose();
    await reader.dispose();
  }
});
