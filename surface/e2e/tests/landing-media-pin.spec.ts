import { deflateSync } from 'node:zlib';
import { expect, test, type Locator } from '@playwright/test';
import {
  apiAs,
  channelId,
  createTestChannel,
  distanceFromBottom,
  login,
  openChannel,
  postWithAttachment,
  seedMessages,
  setReadCursor,
  unique,
  uploadViaApi,
} from './helpers.js';

const PNG_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < PNG_CRC_TABLE.length; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  PNG_CRC_TABLE[i] = c >>> 0;
}

function pngCrc32(parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32([typeBytes, data]), 8 + data.byteLength);
  return chunk;
}

function generatedPng(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      pixels[offset] = Math.round((x / Math.max(width - 1, 1)) * 255);
      pixels[offset + 1] = Math.round((y / Math.max(height - 1, 1)) * 180);
      pixels[offset + 2] = 220;
    }
  }

  return Buffer.concat([
    header,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const LATE_IMAGE_PNG = generatedPng(640, 480);

async function scrollHeight(log: Locator): Promise<number> {
  return log.evaluate((node) => (node as HTMLElement).scrollHeight);
}

test('fully read channel stays pinned when a landing image finishes loading late', async ({ page }) => {
  test.slow();
  const room = await createTestChannel('mediapin');
  const readerHandle = unique('reader');
  const writer = await apiAs(unique('writer'), 'Writer');
  const reader = await apiAs(readerHandle, 'Reader');
  let releaseImageResponse: () => void = () => {};

  try {
    const roomId = await channelId(writer, room);
    const fillerIds = await seedMessages(writer, roomId, 'media pin filler', 28);
    let latestId = fillerIds.at(-1)!;
    const fileId = await uploadViaApi(writer, 'late-growth.png', 'image/png', LATE_IMAGE_PNG, {
      width: 640,
      height: 480,
    });
    latestId = await postWithAttachment(writer, roomId, 'late image attachment', fileId);
    await setReadCursor({
      handle: readerHandle,
      channelId: roomId,
      lastReadEventId: latestId,
    });

    let imageRequestSeen = false;
    const imageResponseReleased = new Promise<void>((resolve) => {
      releaseImageResponse = resolve;
    });
    await page.route(
      `**/api/files/${fileId}**`,
      async (route) => {
        imageRequestSeen = true;
        await imageResponseReleased;
        await route.continue();
      },
      { times: 1 },
    );

    await login(page, readerHandle, 'Reader');
    await openChannel(page, room);

    const log = page.getByRole('log', { name: 'Messages' });
    await expect(log.getByText('late image attachment', { exact: true })).toBeVisible();
    await expect.poll(() => imageRequestSeen).toBe(true);
    await expect.poll(() => distanceFromBottom(log)).toBeLessThan(8);
    const scrollHeightInFlight = await scrollHeight(log);
    releaseImageResponse();

    const img = page.getByRole('button', { name: 'late-growth.png' }).locator('img');
    await expect
      .poll(
        () =>
          img.evaluate((node) => {
            const image = node as HTMLImageElement;
            return image.complete && image.naturalHeight > 0;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);

    const scrollHeightComplete = await scrollHeight(log);
    expect(Math.abs(scrollHeightComplete - scrollHeightInFlight)).toBeLessThanOrEqual(2);
    await expect.poll(() => distanceFromBottom(log)).toBeLessThan(8);
  } finally {
    releaseImageResponse();
    await writer.dispose();
    await reader.dispose();
  }
});
