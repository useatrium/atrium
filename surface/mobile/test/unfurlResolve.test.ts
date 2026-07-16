import { describe, expect, it, vi } from 'vitest';
import { UNFURL_RESOLVE_MAX_URLS } from '@atrium/surface-client';
import { createUnfurlResolver } from '../src/lib/unfurlResolve';

describe('createUnfurlResolver', () => {
  it('batches up to the contract limit and caches results including nulls', async () => {
    const urls = Array.from({ length: UNFURL_RESOLVE_MAX_URLS + 2 }, (_, index) => `https://example.com/${index}`);
    const resolveUnfurls = vi.fn(async (requested: string[]) => ({
      results: Object.fromEntries(
        requested.map((url, index) => [url, index === 1 ? null : { url, kind: 'og' as const, title: url }]),
      ),
    }));
    const resolve = createUnfurlResolver({ resolveUnfurls } as never);

    const first = await resolve(urls);
    expect(resolveUnfurls).toHaveBeenCalledTimes(1);
    expect(resolveUnfurls).toHaveBeenCalledWith(urls.slice(0, UNFURL_RESOLVE_MAX_URLS));
    expect(Object.keys(first)).toEqual(urls.slice(0, UNFURL_RESOLVE_MAX_URLS));
    expect(first[urls[1] ?? '']).toBeNull();

    await resolve([urls[1] ?? '', urls[0] ?? '']);
    expect(resolveUnfurls).toHaveBeenCalledTimes(1);
  });

  it('never sends internal Atrium routes to the external unfurl API', async () => {
    const internal = 'https://prod.atrium.test/c/channel-1/s/session-1';
    const external = 'https://example.com/story';
    const resolveUnfurls = vi.fn(async () => ({
      results: { [external]: { url: external, kind: 'og' as const, title: 'Story' } },
    }));
    const resolve = createUnfurlResolver({ resolveUnfurls } as never);

    await expect(resolve([internal, external])).resolves.toEqual({
      [internal]: null,
      [external]: { url: external, kind: 'og', title: 'Story' },
    });
    expect(resolveUnfurls).toHaveBeenCalledWith([external]);
  });
});
