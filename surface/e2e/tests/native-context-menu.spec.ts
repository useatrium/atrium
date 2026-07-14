import { expect, test, type Locator, type Page } from '@playwright/test';
import { channelButton, login, messageRow, sendMessage, unique } from './helpers.js';

// The app used to preventDefault() every right-click on message rows, transcript
// entries and channel rows to show its own action menu, which swallowed the
// browser's — no Copy on a selection, no "Open link in new tab", no "Save image
// as". Every action now has a visible affordance instead (the ⋯ buttons), so
// right-click belongs to the browser again.
//
// Playwright cannot see the native menu, so we assert the thing that causes it:
// the contextmenu event must reach the document uncancelled. A document-level
// bubble listener runs after the row's own handlers, so defaultPrevented here is
// exactly what the browser will act on.
async function rightClickAndReadDefaultPrevented(page: Page, target: Locator): Promise<boolean> {
  await page.evaluate(() => {
    const w = window as typeof window & { __ctxPrevented?: boolean };
    delete w.__ctxPrevented;
    document.addEventListener(
      'contextmenu',
      (event) => {
        w.__ctxPrevented = event.defaultPrevented;
      },
      { once: true },
    );
  });
  await target.click({ button: 'right' });
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __ctxPrevented?: boolean }).__ctxPrevented))
    .not.toBeUndefined();
  return (await page.evaluate(
    () => (window as typeof window & { __ctxPrevented?: boolean }).__ctxPrevented,
  )) as boolean;
}

test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

test('right-click on a message row leaves the native menu to the browser', async ({ page }) => {
  await login(page, unique('ctx-msg'), 'Ctx Message');
  const text = unique('native-ctx-message');
  await sendMessage(page, text);

  const prevented = await rightClickAndReadDefaultPrevented(page, messageRow(page, text));

  expect(prevented).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Message actions' })).toHaveCount(0);
});

test('right-click on a channel row leaves the native menu to the browser', async ({ page }) => {
  await login(page, unique('ctx-chan'), 'Ctx Channel');

  const prevented = await rightClickAndReadDefaultPrevented(page, channelButton(page, 'general'));

  expect(prevented).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Channel actions' })).toHaveCount(0);
});

// The actions the right-click menu used to own must all still be reachable, now
// from a visible, keyboard-focusable button. "Delegate to agent…" is the one that
// had no other affordance at all before this change.
test('the message overflow button exposes the actions right-click used to own', async ({ page }) => {
  await login(page, unique('ctx-more'), 'Ctx More');
  const text = unique('overflow-actions');
  await sendMessage(page, text);

  const row = messageRow(page, text);
  await row.hover();
  await row.getByRole('button', { name: 'More message actions' }).click();

  const menu = page.getByRole('dialog', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Delegate to agent…' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Reply in thread' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Copy link' })).toBeVisible();
});

// Pin and Archive used to be display:none below 12rem/15.5rem of sidebar width,
// which made right-click their only route at narrow widths — and no route at all
// on touch. The ⋯ must carry them at every width.
test('channel overflow button exposes Pin, Archive and Mute', async ({ page }) => {
  await login(page, unique('ctx-chan-more'), 'Ctx Channel More');

  const row = channelButton(page, 'general').locator('xpath=ancestor::li[1]');
  await row.hover();
  await row.getByRole('button', { name: /^More actions for/ }).click();

  const menu = page.getByRole('dialog', { name: 'Channel actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Pin' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Mute' })).toBeVisible();
});
