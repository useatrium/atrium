import { expect, test, type Locator } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  createTestChannel,
  expectUnread,
  login,
  openChannel,
  postMessage,
  unique,
} from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function setReadCursor(args: { handle: string; channelId: string; lastReadEventId: number }): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error(`missing e2e user: ${args.handle}`);
    await client.query(
      `INSERT INTO channel_read_cursors (user_id, channel_id, last_read_event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET last_read_event_id = EXCLUDED.last_read_event_id,
                     updated_at = now()`,
      [userId, args.channelId, args.lastReadEventId],
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function readCursor(args: { handle: string; channelId: string }): Promise<number> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    const result = await client.query<{ last_read_event_id: string | number }>(
      `SELECT rc.last_read_event_id
       FROM channel_read_cursors rc
       JOIN users u ON u.id = rc.user_id
       WHERE u.handle = $1 AND rc.channel_id = $2`,
      [args.handle, args.channelId],
    );
    return Number(result.rows[0]?.last_read_event_id ?? 0);
  } finally {
    client.release();
    await pool.end();
  }
}

async function seedMessages(
  ctx: Awaited<ReturnType<typeof apiAs>>,
  channelIdValue: string,
  prefix: string,
  count: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    ids.push(await postMessage(ctx, channelIdValue, `${prefix} ${i}`));
  }
  return ids;
}

async function distanceFromBottom(log: Locator): Promise<number> {
  return log.evaluate((node) => {
    const el = node as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

async function expectDividerInTimelineViewport(divider: Locator): Promise<void> {
  await expect
    .poll(async () =>
      divider.evaluate((node) => {
        const scroller = node.closest('[role="log"]');
        if (!scroller) return false;
        const rect = node.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        return rect.top >= bounds.top - 2 && rect.top <= bounds.bottom + 2;
      }),
    )
    .toBe(true);
}

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

    const latestRow = log.locator(`[data-eid="${latestId}"]`);
    await latestRow.scrollIntoViewIfNeeded();
    await expect(latestRow).toBeVisible();
    await expect
      .poll(() => readCursor({ handle: readerHandle, channelId: roomId }), {
        intervals: [300, 700, 1000, 2000],
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(latestId);

    await page.reload();
    await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
    await expect(log.locator(`[data-eid="${latestId}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-unread-divider]')).toHaveCount(0);
    await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  } finally {
    await writer.dispose();
    await reader.dispose();
  }
});
