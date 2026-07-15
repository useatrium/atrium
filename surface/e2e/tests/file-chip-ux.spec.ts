import { expect, test } from '@playwright/test';
import {
  apiURL,
  channelId,
  createTestChannel,
  injectSession,
  injectSessionReply,
  login,
  openChannel,
  unique,
} from './helpers.js';

// UX around file chips and /files deep links: failures must be loud and
// retryable (no silent grey-out), and a ?file= deep link must reveal its file
// even when current filters exclude it (e.g. tombstoned).

test('unresolvable chip toasts and stays clickable; retry opens once captured', async ({ page }) => {
  const room = await createTestChannel('chip-toast');
  const handle = unique('chiptoast');
  await login(page, handle, 'Chip Toast Tester');
  const roomId = await channelId(page.context().request, room);
  const { rootId, sessionId } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('chip-toast-session'),
  });

  // The reply links a file that has NOT been captured yet.
  const fileName = `${unique('late-capture')}.md`;
  await injectSessionReply({
    channelId: roomId,
    rootId,
    sessionId,
    text: `Wrote [${fileName}](/home/agent/${fileName}).`,
  });

  await openChannel(page, room);
  const chip = page.getByRole('button', { name: fileName }).first();
  await expect(chip).toBeVisible();
  await chip.click();

  // Loud failure: toast appears, chip is NOT disabled, no navigation happened.
  await expect(page.getByText(`Couldn't open ${fileName} — the file wasn't captured or was removed.`)).toBeVisible();
  await expect(chip).toBeEnabled();
  expect(new URL(page.url()).pathname).not.toContain('/files');

  // Capture lands late; the same chip now resolves on retry.
  const put = await page
    .context()
    .request.put(
      `${apiURL}/api/channels/${roomId}/artifacts?session=${sessionId}&path=${encodeURIComponent(fileName)}`,
      {
        headers: { 'content-type': 'text/markdown' },
        data: Buffer.from('# Late capture\n\nnow it exists\n', 'utf8'),
      },
    );
  expect(put.ok(), `PUT channel artifact (${put.status()})`).toBeTruthy();

  await chip.click();
  await expect(page).toHaveURL(/\/files\?/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#lightbox-title')).toHaveText(fileName);
});

test('a /files?file= deep link reveals a tombstoned file outside current filters', async ({ page }) => {
  const room = await createTestChannel('chip-reveal');
  const handle = unique('chipreveal');
  await login(page, handle, 'Chip Reveal Tester');
  const roomId = await channelId(page.context().request, room);
  const { sessionId } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('chip-reveal-session'),
  });

  const fileName = `${unique('deleted-doc')}.md`;
  const put = await page
    .context()
    .request.put(
      `${apiURL}/api/channels/${roomId}/artifacts?session=${sessionId}&path=${encodeURIComponent(fileName)}`,
      {
        headers: { 'content-type': 'text/markdown' },
        data: Buffer.from('# Deleted doc\n\nstill addressable\n', 'utf8'),
      },
    );
  expect(put.ok(), `PUT channel artifact (${put.status()})`).toBeTruthy();

  const resolved = await page
    .context()
    .request.get(`${apiURL}/api/files/by-path?path=${encodeURIComponent(`shared/channels/${roomId}/${fileName}`)}`);
  expect(resolved.ok()).toBeTruthy();
  const { artifactId } = (await resolved.json()) as { artifactId: string };

  // Tombstone it — the hub's default filters (includeDeleted=false) now
  // exclude it, which used to make the deep link a silent no-op.
  const del = await page.context().request.delete(`${apiURL}/api/files/${artifactId}`);
  expect(del.ok(), `DELETE file (${del.status()})`).toBeTruthy();

  await page.goto(`/files?file=${artifactId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#lightbox-title')).toHaveText(fileName);
});
