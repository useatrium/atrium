import { expect, test, type Locator, type Page } from '@playwright/test';
import { createTestChannel, login, messageRow, openChannel, sendMessage, unique } from './helpers.js';

/**
 * The audience pill shares the input frame with the textarea. A class-name test
 * cannot see the result of that fight — only real layout can — and the first cut
 * of this feature shipped a thread composer whose textarea was squeezed to
 * exactly 0px wide: the typed text was in the DOM and invisible on screen. These
 * tests measure the rendered box.
 */
async function composerWidths(frame: Locator) {
  return {
    pill: (await frame.getByTestId('composer-audience-pill').boundingBox())?.width ?? 0,
    input: (await frame.getByLabel('Message input').boundingBox())?.width ?? 0,
  };
}

function threadPanel(page: Page): Locator {
  // The thread panel's heading is the conversation's identity (the attached
  // session's title, or the root message's author) — there is no generic
  // "Thread" heading to select it by. Identify it by the control only it has.
  return page.locator('aside').filter({ has: page.getByLabel('Close thread') });
}

test('thread composer keeps a typable input next to the audience pill, in both audiences', async ({ page }) => {
  const room = await createTestChannel('pill');
  await login(page, unique('piller'), 'Piller');
  await openChannel(page, room);

  const root = unique('pill-root');
  await sendMessage(page, root, room);
  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });

  const thread = threadPanel(page);
  await expect(thread.getByTestId('composer-audience-pill')).toBeVisible();

  const chat = await composerWidths(thread);
  expect(chat.pill).toBeGreaterThan(0);
  expect(chat.input).toBeGreaterThan(80);

  // Agent mode carries the longest label ("New agent · this thread"), which is
  // where the pill previously ate the entire row.
  await thread.getByLabel('Message input').fill('!!');
  await expect(thread.getByTestId('composer-audience-pill')).toHaveAttribute('aria-pressed', 'true');
  await thread.getByLabel('Message input').fill('rerun the failing test');

  const agent = await composerWidths(thread);
  expect(agent.pill).toBeGreaterThan(0);
  expect(agent.input).toBeGreaterThan(80);
  await expect(thread.getByLabel('Message input')).toHaveValue('rerun the failing test');
});

test('thread composer survives the pane dragged to its narrowest', async ({ page }) => {
  const room = await createTestChannel('pillnarrow');
  await login(page, unique('narrower'), 'Narrower');
  await openChannel(page, room);

  const root = unique('narrow-root');
  await sendMessage(page, root, room);
  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });

  const thread = threadPanel(page);
  await expect(thread.getByTestId('composer-audience-pill')).toBeVisible();

  // Drag the resize handle hard to the right: the pane clamps at its minimum width.
  const handle = page.getByTestId('thread-resize-handle');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  await thread.getByLabel('Message input').fill('!!');
  await expect(thread.getByTestId('composer-audience-pill')).toHaveAttribute('aria-pressed', 'true');
  await thread.getByLabel('Message input').fill('still typable');

  const agent = await composerWidths(thread);
  expect(agent.pill).toBeGreaterThan(0);
  expect(agent.input).toBeGreaterThan(80);
  await expect(thread.getByLabel('Message input')).toHaveValue('still typable');
});

test('the audience pill does not steal the channel sidebar button name', async ({ page }) => {
  const room = await createTestChannel('pillname');
  await login(page, unique('namer'), 'Namer');
  await openChannel(page, room);

  // The pill's chat label is literally "#<channel>". If it were named by its own
  // text it would collide with the sidebar's channel button — which is exactly
  // how it broke openChannel across the suite.
  await expect(page.getByRole('button', { name: new RegExp(`^#?\\s*${room}(\\s|$)`) })).toHaveCount(1);
});

test('typing !! then a task leaves no leading space in the draft', async ({ page }) => {
  const room = await createTestChannel('sigil');
  await login(page, unique('sigiler'), 'Sigiler');
  await openChannel(page, room);

  const input = page.getByLabel('Message input');
  await input.click();
  // Typed key-by-key: the sigil is swallowed on "!!", so the following space
  // lands on an otherwise-empty input.
  await page.keyboard.type('!! rerun the failing test');

  await expect(page.getByTestId('composer-audience-pill')).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('rerun the failing test');
});
