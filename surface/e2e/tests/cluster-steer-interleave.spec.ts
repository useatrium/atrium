import { expect, test, type Locator } from '@playwright/test';
import {
  channelId,
  confirmedRowsWithText,
  createTestChannel,
  injectSessionReply,
  injectSteer,
  login,
  messageId,
  openChannel,
  sendMessage,
  unique,
} from './helpers.js';

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return box.y;
}

// The channel cluster used to split rendering: agent responses in always-visible
// slots, everything else (steers) in the expanded "N earlier replies" block —
// two disjoint regions that can never interleave. This asserts that expanding
// the cluster now shows one chronological thread where a human's steer sits
// between the agent's responses, matching the dedicated thread panel.
test('expanding the channel cluster interleaves a human steer between agent responses', async ({ page }) => {
  const room = await createTestChannel('steer-interleave');
  const handle = unique('steerer');
  await login(page, handle, 'Steer Human');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const root = unique('steer-root');
  await sendMessage(page, root, room);
  const rootId = await messageId(page, root);

  // A well-formed UUID that need not reference a live session: the seed helpers'
  // sessions UPDATE no-ops, and the steer only needs steered_session_id present.
  const sessionId = '11111111-1111-4111-8111-111111111111';
  // Seed in chronological order (event id ascending): response, steer, response.
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: 'Agent first response' });
  await injectSteer({ handle, channelId: roomId, rootId, sessionId, text: 'Human steer in the middle' });
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: 'Agent second response' });

  // Reload so the channel refetches history with the seeded replies + count.
  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();

  const cluster = confirmedRowsWithText(page, root).first().getByTestId('channel-annotation-cluster');

  // Collapsed: only the final reply shows; the earlier reply and the steer are
  // folded behind the "N earlier replies" count.
  await expect(cluster.getByText('Agent second response')).toBeVisible();
  await expect(cluster.getByText('Agent first response')).toHaveCount(0);
  await expect(page.getByText('Human steer in the middle')).toHaveCount(0);

  const earlier = cluster.getByRole('button', { name: /earlier repl/ });
  await expect(earlier).toBeVisible();
  await earlier.click();

  // Expanded: one chronological list. The steer carries the "→ agent" pill and
  // sits between the two agent responses.
  await expect(cluster.getByText('Human steer in the middle')).toBeVisible();
  await expect(cluster.getByText('→ agent')).toBeVisible();

  const firstTop = await top(cluster.getByText('Agent first response'));
  const steerTop = await top(cluster.getByText('Human steer in the middle'));
  const secondTop = await top(cluster.getByText('Agent second response'));
  expect(firstTop).toBeLessThan(steerTop);
  expect(steerTop).toBeLessThan(secondTop);
});

// jsdom has no layout, so only a real browser can prove what the user reported:
// "Show more" CUT the reply to three lines and a "…" instead of expanding it.
// The row's line-clamp-3 wrapped MessageText's own max-height, and releasing the
// inner constraint is what finally let the outer clamp bite.
test('Show more grows a long agent reply instead of shrinking it', async ({ page }) => {
  const room = await createTestChannel('clamp-grow');
  const handle = unique('clamper');
  await login(page, handle, 'Clamp Human');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const root = unique('clamp-root');
  await sendMessage(page, root, room);
  const rootId = await messageId(page, root);

  const sessionId = '11111111-1111-4111-8111-111111111111';
  const longReply = Array.from(
    { length: 30 },
    (_, i) => `Step ${i + 1}: inspected the preview launcher path and confirmed the credential scope boundary holds.`,
  ).join('\n');
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: longReply });

  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();

  const reply = confirmedRowsWithText(page, root).first().getByTestId('thread-compact-reply').first();
  await expect(reply).toBeVisible();

  const showMore = reply.getByRole('button', { name: 'Show more' });
  await expect(showMore).toBeVisible();
  const clamped = (await reply.boundingBox())!.height;

  await showMore.click();
  const expanded = (await reply.boundingBox())!.height;
  // The whole point: expanding must reveal more of the reply, never less.
  expect(expanded).toBeGreaterThan(clamped);
  await expect(reply.getByRole('button', { name: 'Show less' })).toBeVisible();

  // ...and it collapses back, so the toggle works in both directions.
  await reply.getByRole('button', { name: 'Show less' }).click();
  expect((await reply.boundingBox())!.height).toBeCloseTo(clamped, 0);
});
