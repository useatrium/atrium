import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './db.js';
import {
  backfillMissingThumbnails,
  ensureThumbnailForBlobDeduped,
  generateThumbnail,
  resetThumbnailWarningStateForTest,
} from './thumbnails.js';

afterEach(() => {
  vi.doUnmock('pdf-to-img');
  resetThumbnailWarningStateForTest();
});

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

  it('dedupes concurrent on-demand generation for the same source sha', async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pool = {} as Db;
    const job = { pool, sourceSha: 'source-sha', mime: 'image/png', mediaKind: 'image' };
    const ensure = vi.fn(async () => {
      calls += 1;
      return pending;
    });

    const first = ensureThumbnailForBlobDeduped(job, ensure);
    const second = ensureThumbnailForBlobDeduped(job, ensure);
    expect(first).toBe(second);
    expect(calls).toBe(1);

    release('thumb-sha');
    await expect(first).resolves.toBe('thumb-sha');
    await expect(second).resolves.toBe('thumb-sha');

    await ensureThumbnailForBlobDeduped(job, ensure);
    expect(calls).toBe(2);
  });

  it('backfill query applies the cap and only scans durable image/pdf/video blobs', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: [
        { sha256: 'image-sha', mime: 'image/png', media_kind: 'image', s3_key: 'cas/image-sha' },
        { sha256: 'pdf-sha', mime: 'application/pdf', media_kind: 'pdf', s3_key: 'cas/pdf-sha' },
      ],
    }));
    const pool = { query } as unknown as Db;
    const enqueue = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await backfillMissingThumbnails(pool, { limit: 7, enqueue, logger });

    expect(result).toEqual({ scanned: 2, enqueued: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("media_kind IN ('image', 'pdf', 'video')"), [7]);
    expect(query.mock.calls[0]?.[0]).toContain('thumbnail_sha IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('s3_key IS NOT NULL');
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY created_at DESC');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: 'image-sha', s3Key: 'cas/image-sha' }));
    expect(logger.info).toHaveBeenCalledWith(
      { scanned: 2, enqueued: 2, limit: 7 },
      'thumbnail backfill queued missing thumbnails',
    );
  });

  it('warns once when a generator import fails', async () => {
    vi.doMock('pdf-to-img', () => {
      throw new Error('mock pdf-to-img import failed');
    });
    const logger = { warn: vi.fn() };
    const input = {
      bytes: Buffer.from('%PDF-1.7\n'),
      mediaKind: 'pdf',
      mime: 'application/pdf',
      logger,
    };

    await expect(generateThumbnail(input)).resolves.toBeNull();
    await expect(generateThumbnail(input)).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('mock pdf-to-img import failed') }),
      'thumbnail generator dependency unavailable: pdf-to-img import failed',
    );
  });
});
