import { expect, test } from '@playwright/test';
import { login, messageRow, sendMessage, unique } from './helpers.js';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('message-action sheet opens on touch long-press without release click-through', async ({
  context,
  page,
}) => {
  await login(page, unique('press'), 'Press Tester');
  const text = [unique('message-action-root'), ...Array.from({ length: 90 }, (_, index) => `hold-${index}`)].join(
    ' ',
  );
  await sendMessage(page, text);

  const row = messageRow(page, text);
  await row.evaluate((element) => element.scrollIntoView({ block: 'end', inline: 'nearest' }));
  const box = await row.boundingBox();
  if (!box) throw new Error('message row did not lay out');

  const desiredY = 610;
  const x = Math.min(box.x + box.width - 16, box.x + 96);
  const y = Math.min(box.y + box.height - 12, Math.max(box.y + 12, desiredY));
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(700);

    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    await expect(dialog).toBeVisible();

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close thread' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Reply…')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Reply in thread' }).tap();
    await expect(page.getByPlaceholder('Reply…')).toBeVisible();
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
    await cdp.detach();
  }
});

// Regression: the swipe handler used to setPointerCapture on the container,
// which transferred the touch pointer's implicit capture and fired a bubbling
// lostpointercapture that the row's own cancel handler consumed — the swipe
// self-destructed one move after engaging, so swipe-to-reply never fired.
test('touch swipe right on a message opens the reply thread', async ({ context, page }) => {
  await login(page, unique('swipe'), 'Swipe Tester');
  const text = unique('swipe-reply-target');
  await sendMessage(page, text);

  const row = messageRow(page, text);
  const box = await row.boundingBox();
  if (!box) throw new Error('message row did not lay out');

  const startX = box.x + 60;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y, id: 1 }],
    });
    // Drag well past SWIPE_REPLY_THRESHOLD_PX (64) with a mostly-horizontal path.
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + step * 18, y: y + 1, id: 1 }],
      });
      await page.waitForTimeout(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(page.getByPlaceholder('Reply…')).toBeVisible();
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
    await cdp.detach();
  }
});

// Regression: TimestampDisclosure used `[@media(hover:none)]:opacity-100`, so
// on touch devices every ungrouped message rendered its exact-timestamp
// tooltip OPEN on load, overlapping the message text. Touch now starts hidden
// and pins on tap (the toggle the component always had).
test('exact-timestamp tooltip is hidden on touch until the timestamp is tapped', async ({
  page,
}) => {
  await login(page, unique('tsq'), 'Timestamp Tester');
  const text = unique('timestamp-quirk');
  await sendMessage(page, text);

  // Guard: this test only means something if the context emulates a no-hover
  // (touch) device — otherwise it would false-pass on the desktop CSS path.
  expect(await page.evaluate(() => window.matchMedia('(hover: none)').matches)).toBe(true);

  const row = messageRow(page, text);
  const tooltip = row.getByRole('tooltip');
  await expect(tooltip).toHaveCount(1);
  const opacityOf = () =>
    tooltip.evaluate((el) => getComputedStyle(el).opacity);
  expect(await opacityOf()).toBe('0');

  await row.getByRole('button', { name: /Exact timestamp:/ }).first().tap();
  await expect.poll(opacityOf).toBe('1');

  // Tapping the timestamp again unpins it.
  await row.getByRole('button', { name: /Exact timestamp:/ }).first().tap();
  await expect.poll(opacityOf).toBe('0');
});
