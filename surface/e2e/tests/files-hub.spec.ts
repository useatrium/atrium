import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  apiAs,
  apiURL,
  channelId,
  createChannel,
  login,
  unique,
  uniqueChannel,
} from './helpers.js';

// A real 64x64 PNG fixture (decodable by browsers AND sharp → produces a real thumbnail).
const PNG_1x1 = readFileSync(fileURLToPath(new URL('./fixtures/sample.png', import.meta.url)));

// Upload bytes through the real pipeline: POST /api/uploads → presigned PUT to
// MinIO → returns the fileId the message attachment references.
async function uploadViaApi(
  ctx: APIRequestContext,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<string> {
  // The real client sends a SHA-256 hex contentHash; the server requires it to
  // register the CAS blob when the upload lands as an artifact.
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
      clientMsgId: unique('api-att'),
    },
  });
  expect(res.ok(), `POST /api/messages with attachment (${res.status()})`).toBeTruthy();
}

type HubFile = {
  artifactId: string;
  name: string;
  origin: string;
  mediaKind: string | null;
  thumbnailUrl?: string | null;
  tombstoned: boolean;
};

async function channelFiles(
  ctx: APIRequestContext,
  chanId: string,
  query = '',
): Promise<HubFile[]> {
  const res = await ctx.get(`/api/channels/${chanId}/files${query}`);
  expect(res.ok(), `GET /api/channels/:id/files (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { files: HubFile[] };
  return body.files;
}

test.describe('Files Hub', () => {
  test('composer shows a pre-send thumbnail chip when a file is selected', async ({ page }) => {
    await login(page, unique('up'), 'Uploader');
    // Selecting a file through the real hidden <input type=file> the paperclip drives
    // renders a pending chip immediately (the thumbnail is a local blob: URL — no network).
    await page.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    // Pre-send preview: an <img> whose src is a local object URL (lane F).
    const thumb = page.locator('img[src^="blob:"]').first();
    await expect(thumb).toBeVisible({ timeout: 10_000 });
  });

  test('a message attachment opens in the shared lightbox', async ({ page }) => {
    // Seed a message + image attachment via the proven API path (the browser's own
    // presigned PUT to storage is cross-origin and out of scope here), as the same
    // user the browser signs in as, so it renders in #general on load.
    const handle = unique('viewer');
    const ctx = await apiAs(handle, 'Viewer');
    try {
      const fileId = await uploadViaApi(ctx, 'diagram.png', 'image/png', PNG_1x1);
      const general = await channelId(ctx, 'general');
      await postWithAttachment(ctx, general, 'here is the diagram', fileId);
    } finally {
      await ctx.dispose();
    }

    await login(page, handle, 'Viewer');
    await expect(page.getByText('here is the diagram', { exact: true })).toBeVisible();

    // The image attachment renders inline as a clickable button (title = filename).
    const attachment = page.getByRole('button', { name: 'diagram.png' }).first();
    await expect(attachment).toBeVisible();
    await attachment.click();

    // The shared lightbox opens with its chrome (lanes D + C).
    const lightbox = page.getByRole('dialog');
    await expect(lightbox).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle info panel' })).toBeVisible();
    await page.getByRole('button', { name: 'Close lightbox' }).click();
    await expect(lightbox).toBeHidden();
  });

  test('uploaded file lands as a channel artifact and lists via the hub API', async () => {
    const ctx = await apiAs(unique('lister'), 'Lister');
    try {
      const name = uniqueChannel('files');
      await createChannel(ctx, name);
      const chanId = await channelId(ctx, name);
      const fileId = await uploadViaApi(ctx, 'notes.png', 'image/png', PNG_1x1);
      await postWithAttachment(ctx, chanId, 'attached notes', fileId);

      const files = await channelFiles(ctx, chanId);
      const landed = files.find((f) => f.name === 'notes.png');
      expect(landed, 'upload should appear as a channel file').toBeTruthy();
      expect(landed?.origin).toBe('upload');
      expect(landed?.mediaKind).toBe('image');
    } finally {
      await ctx.dispose();
    }
  });

  test('deleting a file tombstones it: 410 on bytes, hidden from default list', async () => {
    const ctx = await apiAs(unique('deleter'), 'Deleter');
    try {
      const name = uniqueChannel('del');
      await createChannel(ctx, name);
      const chanId = await channelId(ctx, name);
      const fileId = await uploadViaApi(ctx, 'trash.png', 'image/png', PNG_1x1);
      await postWithAttachment(ctx, chanId, 'to be deleted', fileId);

      const before = await channelFiles(ctx, chanId);
      const artifactId = before.find((f) => f.name === 'trash.png')?.artifactId;
      expect(artifactId).toBeTruthy();

      // Bytes are reachable before deletion.
      const preBytes = await ctx.get(`/api/files/${fileId}`, { maxRedirects: 0 });
      expect([200, 302]).toContain(preBytes.status());

      const del = await ctx.delete(`/api/files/${artifactId}`);
      expect(del.ok(), `DELETE (${del.status()})`).toBeTruthy();
      expect(((await del.json()) as { tombstoned: boolean }).tombstoned).toBe(true);

      // Tombstone gate: the upload byte route now returns 410 Gone.
      const postBytes = await ctx.get(`/api/files/${fileId}`, { maxRedirects: 0 });
      expect(postBytes.status()).toBe(410);

      // Hidden from the default list; visible (as tombstoned) with includeDeleted.
      const afterDefault = await channelFiles(ctx, chanId);
      expect(afterDefault.find((f) => f.name === 'trash.png')).toBeFalsy();
      const afterAll = await channelFiles(ctx, chanId, '?includeDeleted=true');
      expect(afterAll.find((f) => f.name === 'trash.png')?.tombstoned).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test('ACL: a non-member cannot list another user\'s private-channel files', async () => {
    const alice = await apiAs(unique('alice'), 'Alice');
    const bob = await apiAs(unique('bob'), 'Bob');
    try {
      // Alice creates a PRIVATE channel and uploads a secret file.
      const priv = uniqueChannel('secret');
      const create = await alice.post('/api/channels', { data: { name: priv, private: true } });
      expect(create.ok(), `create private channel (${create.status()})`).toBeTruthy();
      const privId = ((await create.json()) as { channel: { id: string } }).channel.id;
      const fileId = await uploadViaApi(alice, 'secret.png', 'image/png', PNG_1x1);
      await postWithAttachment(alice, privId, 'top secret', fileId);

      // Alice sees her file.
      expect((await channelFiles(alice, privId)).some((f) => f.name === 'secret.png')).toBe(true);

      // Bob (not a member) is denied the channel file list.
      const bobList = await bob.get(`/api/channels/${privId}/files`);
      expect([403, 404]).toContain(bobList.status());
    } finally {
      await alice.dispose();
      await bob.dispose();
    }
  });

  test('image upload gets an eager server-generated thumbnail', async () => {
    const ctx = await apiAs(unique('thumb'), 'Thumb');
    try {
      const name = uniqueChannel('thumb');
      await createChannel(ctx, name);
      const chanId = await channelId(ctx, name);
      const fileId = await uploadViaApi(ctx, 'pic.png', 'image/png', PNG_1x1);
      await postWithAttachment(ctx, chanId, 'has a thumbnail', fileId);

      // Thumbnail generation is fire-and-forget at ingest — poll briefly for it.
      let thumbUrl: string | null | undefined;
      await expect
        .poll(
          async () => {
            const f = (await channelFiles(ctx, chanId)).find((x) => x.name === 'pic.png');
            thumbUrl = f?.thumbnailUrl;
            return thumbUrl ?? null;
          },
          { timeout: 15_000, intervals: [500, 1000, 2000] },
        )
        .not.toBeNull();

      const thumb = await ctx.get(`${apiURL}${thumbUrl}`, { maxRedirects: 0 });
      expect([200, 302]).toContain(thumb.status());
    } finally {
      await ctx.dispose();
    }
  });

  test('version list, prior-version bytes (?at), and embeddable app preview', async () => {
    const ctx = await apiAs(unique('ver'), 'Ver');
    try {
      const name = uniqueChannel('ver');
      await createChannel(ctx, name);
      const chanId = await channelId(ctx, name);
      const html = Buffer.from('<!doctype html><title>hi</title><h1>hello app</h1>');
      const fileId = await uploadViaApi(ctx, 'app.html', 'text/html', html);
      await postWithAttachment(ctx, chanId, 'an app', fileId);
      const artifactId = (await channelFiles(ctx, chanId)).find((f) => f.name === 'app.html')?.artifactId;
      expect(artifactId).toBeTruthy();

      // versions: at least the created version, newest marked latest.
      const vres = await ctx.get(`/api/files/${artifactId}/versions`);
      expect(vres.ok(), `versions (${vres.status()})`).toBeTruthy();
      const versions = ((await vres.json()) as { versions: Array<{ seq: number; isLatest: boolean }> }).versions;
      const latest = versions[0];
      expect(latest, 'at least one version').toBeTruthy();
      expect(latest!.isLatest).toBe(true);

      // prior-version bytes via ?at
      const at = await ctx.get(`/api/files/artifact/${artifactId}/content?at=${latest!.seq}`);
      expect(at.status()).toBe(200);
      expect((await at.body()).byteLength).toBeGreaterThan(0);

      // app preview: embeddable HTML with CSP; but a top-level document navigation is refused.
      const embed = await ctx.get(`/api/files/${artifactId}/preview?renderer=html-app`, {
        headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
      });
      expect(embed.status(), `preview embed (${embed.status()})`).toBe(200);
      expect(embed.headers()['content-security-policy']).toBeTruthy();

      const topLevel = await ctx.get(`/api/files/${artifactId}/preview?renderer=html-app`, {
        headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
      });
      expect(topLevel.status(), 'top-level preview navigation must be refused').toBe(403);
    } finally {
      await ctx.dispose();
    }
  });
});
