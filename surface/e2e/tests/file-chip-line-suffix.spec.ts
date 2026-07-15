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

// Regression: agents habitually link sandbox files with an editor-style line
// suffix (`[notes.md](/home/agent/notes.md:1)`). The suffix must not leak into
// the ledger path, or the chip 404s on /api/files/by-path and silently greys
// out (prod thread /c/d4dbf59b…/t/466).
test('file chip with an editor :line suffix resolves and opens the file', async ({ page }) => {
  const room = await createTestChannel('chip-line');
  const handle = unique('chipline');
  await login(page, handle, 'Chip Line Tester');
  const roomId = await channelId(page.context().request, room);
  const { rootId, sessionId } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('chip-line-session'),
  });

  // Capture a real ledger artifact at shared/channels/<room>/<file>.
  const fileName = `${unique('chip-notes')}.md`;
  const put = await page
    .context()
    .request.put(
      `${apiURL}/api/channels/${roomId}/artifacts?session=${sessionId}&path=${encodeURIComponent(fileName)}`,
      {
        headers: { 'content-type': 'text/markdown' },
        data: Buffer.from('# Chip target\n\nhello from the chip e2e\n', 'utf8'),
      },
    );
  expect(put.ok(), `PUT channel artifact (${put.status()})`).toBeTruthy();

  // The agent's reply links the sandbox home path, with the `:1` suffix.
  await injectSessionReply({
    channelId: roomId,
    rootId,
    sessionId,
    text: `Added it to [${fileName}](/home/agent/${fileName}:1).`,
  });

  await openChannel(page, room);
  const chip = page.getByRole('button', { name: fileName }).first();
  await expect(chip).toBeVisible();
  await chip.click();

  // The chip resolves through /api/files/by-path and lands in the Files hub
  // lightbox — it must not flip to the disabled "File not available" state.
  await expect(page).toHaveURL(/\/files\?/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#lightbox-title')).toHaveText(fileName);
  // The rendered markdown body (a real heading, not the filmstrip tile's text).
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Chip target' })).toBeVisible();
});
