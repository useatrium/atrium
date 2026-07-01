import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { generateThumbnail } from './thumbnails.js';

describe('generateThumbnail', () => {
  it('resizes image bytes into a small webp thumbnail', async () => {
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: '#336699',
      },
    })
      .png()
      .toBuffer();

    const thumbnail = await generateThumbnail({
      bytes: source,
      mediaKind: 'image',
      mime: 'image/png',
    });

    expect(thumbnail?.mime).toBe('image/webp');
    expect(thumbnail?.bytes.byteLength).toBeGreaterThan(0);
    const meta = await sharp(thumbnail!.bytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(320);
    expect(meta.height).toBeLessThanOrEqual(320);
  });
});
