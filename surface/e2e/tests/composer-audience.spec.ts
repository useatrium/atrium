import { expect, test, type Locator, type Page } from '@playwright/test';
import { createTestChannel, login, messageRow, openChannel, sendMessage, unique } from './helpers.js';

/**
 * The audience switch shares the input frame with the textarea. A class-name test
 * cannot see the result of that fight — only real layout can — and the first cut
 * of this feature shipped a thread composer whose textarea was squeezed to
 * exactly 0px wide: the typed text was in the DOM and invisible on screen. These
 * tests measure the rendered box.
 */
async function composerWidths(frame: Locator) {
  return {
    audienceSwitch: (await frame.getByTestId('composer-audience-pill').boundingBox())?.width ?? 0,
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
  expect(chat.audienceSwitch).toBeGreaterThan(0);
  expect(chat.input).toBeGreaterThan(80);

  // Agent mode used to carry a long label, which is where the old pill ate the
  // entire row. The switch must remain compact in either state.
  await thread.getByLabel('Message input').fill('!!');
  await expect(thread.getByTestId('composer-audience-pill')).toHaveAttribute('aria-checked', 'true');
  await thread.getByLabel('Message input').fill('rerun the failing test');

  const agent = await composerWidths(thread);
  expect(agent.audienceSwitch).toBeGreaterThan(0);
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
  await expect(thread.getByTestId('composer-audience-pill')).toHaveAttribute('aria-checked', 'true');
  await thread.getByLabel('Message input').fill('still typable');

  const agent = await composerWidths(thread);
  expect(agent.audienceSwitch).toBeGreaterThan(0);
  expect(agent.input).toBeGreaterThan(80);
  await expect(thread.getByLabel('Message input')).toHaveValue('still typable');
});

test('the audience switch does not steal the channel sidebar button name', async ({ page }) => {
  const room = await createTestChannel('pillname');
  await login(page, unique('namer'), 'Namer');
  await openChannel(page, room);

  // The control has its own stable accessible name rather than inheriting a
  // channel label that would collide with the sidebar button.
  await expect(page.getByRole('button', { name: new RegExp(`^#?\\s*${room}(\\s|$)`) })).toHaveCount(1);
});

test('switching to Agent keeps the microphone slot and composer controls aligned', async ({ page }) => {
  const room = await createTestChannel('switchgeometry');
  await login(page, unique('switchgeometry'), 'Switch Geometry');
  await openChannel(page, room);

  const main = page.locator('main');
  const audienceSwitch = main.getByTestId('composer-audience-pill');
  const voice = main.getByTestId('composer-voice-button');
  const attach = main.getByRole('button', { name: 'Attach a file' });
  const input = main.getByLabel('Message input');
  const send = main.getByRole('button', { name: 'Message', exact: true });

  const beforeVoice = (await voice.boundingBox())!;
  const controls = await Promise.all(
    [attach, voice, audienceSwitch, input, send].map((control) => control.boundingBox()),
  );
  const bottoms = controls.map((box) => Math.round((box?.y ?? 0) + (box?.height ?? 0)));
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);

  await audienceSwitch.click();
  await expect(audienceSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(voice).toBeDisabled();
  const afterVoice = (await voice.boundingBox())!;
  expect(afterVoice).toEqual(beforeVoice);
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

  await expect(page.getByTestId('composer-audience-pill')).toHaveAttribute('aria-checked', 'true');
  await expect(input).toHaveValue('rerun the failing test');
});
