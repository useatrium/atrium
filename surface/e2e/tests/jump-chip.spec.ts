import { expect, test, type Locator } from '@playwright/test';
import {
  channelId,
  createTestChannel,
  goOffline,
  injectSession,
  injectSessionReply,
  login,
  messageRow,
  openChannel,
  postMessage,
  unique,
} from './helpers.js';

async function expectOutsideViewport(row: Locator, viewport: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const rowBox = await row.boundingBox();
      const viewportBox = await viewport.boundingBox();
      if (!rowBox || !viewportBox) return false;
      return rowBox.y + rowBox.height <= viewportBox.y || rowBox.y >= viewportBox.y + viewportBox.height;
    })
    .toBe(true);
}

async function expectInsideViewport(row: Locator, viewport: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const rowBox = await row.boundingBox();
      const viewportBox = await viewport.boundingBox();
      if (!rowBox || !viewportBox) return false;
      return rowBox.y + rowBox.height > viewportBox.y && rowBox.y < viewportBox.y + viewportBox.height;
    })
    .toBe(true);
}

test('an off-screen agent answer offers a jump back to its root', async ({ page, context }) => {
  const room = await createTestChannel('answer-jump');
  const handle = unique('answer-jumper');
  await login(page, handle, 'Answer Jumper');
  const roomId = await channelId(page.context().request, room);
  const task = unique('top-agent-task');
  const { rootId, sessionId } = await injectSession({ handle, channelId: roomId, title: task });

  for (let index = 0; index < 30; index += 1) {
    await postMessage(page.context().request, roomId, `${unique('filler')}-${index}`);
  }
  await openChannel(page, room);

  const timeline = page.getByRole('log', { name: 'Messages' });
  const root = messageRow(page, task);
  await timeline.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await expectOutsideViewport(root, timeline);
  await expect(page.getByTestId('agent-answer-jump-chip')).toHaveCount(0);

  // Directly append the same broadcast event produced when SessionRuns
  // completes. Reconnecting exercises the real channel after_id catch-up path.
  await goOffline(page, context, { signal: true });
  await expect(page.getByText(/Reconnecting/)).toBeVisible();
  const answer = unique('agent-finished');
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: answer });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();

  const chip = page.getByTestId('agent-answer-jump-chip');
  await expect(chip).toContainText(task.slice(0, 40));
  await chip.click();
  await expect(chip).toHaveCount(0);
  await expectInsideViewport(root, timeline);
  // Live, the injected session still reads as running (a raw DB status flip
  // emits no WS event), so the slot shows its working strip. Reload to take the
  // server snapshot — completed session + anchored answer in the cluster.
  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  await expect(root.getByTestId('channel-annotation-cluster').getByText(answer, { exact: true })).toBeVisible();
});
