import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiAs, channelId, login, unique } from './helpers.js';

const PNG_1x1 = readFileSync(fileURLToPath(new URL('./fixtures/sample.png', import.meta.url)));

type HubFile = {
  artifactId: string;
  name: string;
};

async function uploadViaApi(
  ctx: APIRequestContext,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<string> {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const created = await ctx.post('/api/uploads', {
    data: { filename, contentType, size: bytes.byteLength, contentHash },
  });
  expect(created.ok(), `POST /api/uploads (${created.status()})`).toBeTruthy();
  const { fileId, uploadUrl } = (await created.json()) as { fileId: string; uploadUrl: string };
  const put = await ctx.put(uploadUrl, {
    headers: { 'content-type': contentType },
    data: bytes,
  });
  expect(put.ok(), `presigned PUT to storage (${put.status()})`).toBeTruthy();
  return fileId;
}

async function postWithAttachment(
  ctx: APIRequestContext,
  channelIdValue: string,
  text: string,
  fileId: string,
): Promise<void> {
  const res = await ctx.post('/api/messages', {
    data: {
      channelId: channelIdValue,
      text,
      attachments: [fileId],
      clientMsgId: unique('addr-att'),
    },
  });
  expect(res.ok(), `POST /api/messages with attachment (${res.status()})`).toBeTruthy();
}

async function channelFiles(ctx: APIRequestContext, chanId: string): Promise<HubFile[]> {
  const res = await ctx.get(`/api/channels/${chanId}/files`);
  expect(res.ok(), `GET /api/channels/:id/files (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { files: HubFile[] };
  return body.files;
}

function searchParam(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

test('/files lightbox file and info panel are URL-addressable', async ({ page }) => {
  test.setTimeout(60_000);
  const handle = unique('addr-files');
  const ctx = await apiAs(handle, 'Addressable Files');
  const firstName = `${unique('addr78-a')}.png`;
  const secondName = `${unique('addr78-b')}.txt`;
  let openArtifactId = '';
  try {
    const general = await channelId(ctx, 'general');
    const firstFileId = await uploadViaApi(ctx, firstName, 'image/png', PNG_1x1);
    await postWithAttachment(ctx, general, `first ${firstName}`, firstFileId);
    const secondFileId = await uploadViaApi(ctx, secondName, 'text/plain', Buffer.from(`second ${secondName}`, 'utf8'));
    await postWithAttachment(ctx, general, `second ${secondName}`, secondFileId);
    const files = await channelFiles(ctx, general);
    openArtifactId = files.find((file) => file.name === secondName)?.artifactId ?? '';
    expect(openArtifactId, 'second upload should land as an artifact').not.toBe('');
  } finally {
    await ctx.dispose();
  }

  await login(page, handle, 'Addressable Files');
  await page.goto('/files?sort=name', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button').filter({ hasText: firstName }).first()).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: secondName }).first()).toBeVisible();

  await page.getByRole('button').filter({ hasText: secondName }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => searchParam(page.url(), 'file')).toBe(openArtifactId);

  const openTitle = await page.locator('#lightbox-title').textContent();
  expect(openTitle?.trim()).toBe(secondName);

  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.locator('#lightbox-title').textContent()).toBe(secondName);
  await expect.poll(() => searchParam(page.url(), 'file')).toBe(openArtifactId);

  await page.getByRole('button', { name: 'Next file' }).click();
  await expect.poll(() => searchParam(page.url(), 'file')).not.toBe(openArtifactId);

  await page.getByRole('button', { name: 'Toggle info panel' }).click();
  await expect.poll(() => searchParam(page.url(), 'panel')).toBe('info');
  await expect(page.getByRole('dialog').getByText('MIME')).toBeVisible();

  await page.reload();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('MIME')).toBeVisible();
  await expect.poll(() => searchParam(page.url(), 'panel')).toBe('info');
});
