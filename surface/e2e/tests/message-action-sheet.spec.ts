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
