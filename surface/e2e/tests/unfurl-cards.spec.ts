import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  channelId,
  createTestChannel,
  login,
  mainComposer,
  messageRow,
  openChannel,
  postWithAttachment,
  unique,
  uploadViaApi,
} from './helpers.js';

const SAMPLE_PNG = readFileSync(fileURLToPath(new URL('./fixtures/sample.png', import.meta.url)));

test('unfurl card shows attachment thumbnail and author removal persists', async ({ page }) => {
  const room = await createTestChannel('unfurl');
  await login(page, unique('unfurler'), 'Unfurl Author');
  await openChannel(page, room);

  const roomId = await channelId(page.context().request, room);
  const filename = `${unique('unfurl-screen')}.png`;
  const sourceText = unique('unfurl-source');
  const fileId = await uploadViaApi(page.context().request, filename, 'image/png', SAMPLE_PNG, {
    width: 64,
    height: 64,
  });
  const sourceEventId = await postWithAttachment(page.context().request, roomId, sourceText, fileId);
  await expect(messageRow(page, sourceText)).toBeVisible();

  // The inline /e/ ref renders as a resolved chip, so the raw text never
  // appears verbatim — sendMessage's exact-text assertion can't be used here.
  const linkText = `Inline unfurl ${unique('idea')}: /e/evt_${sourceEventId}`;
  await mainComposer(page, room).fill(linkText);
  await mainComposer(page, room).press('Enter');
  const linkedRow = messageRow(page, 'Inline unfurl');
  await expect(linkedRow).toBeVisible();
  const thumbnail = linkedRow.getByRole('img', { name: filename });
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute('src', `/api/files/${fileId}`);

  await linkedRow.getByRole('button', { name: 'Remove preview' }).click();
  await expect(thumbnail).toHaveCount(0);

  await page.reload();
  await openChannel(page, room);
  const reloadedRow = messageRow(page, 'Inline unfurl');
  await expect(reloadedRow).toBeVisible();
  await expect(reloadedRow.getByRole('img', { name: filename })).toHaveCount(0);
  await expect(reloadedRow.getByRole('button', { name: 'Remove preview' })).toHaveCount(0);
});
