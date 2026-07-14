import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUnfurlResolveCacheForTests, resolveUnfurls } from './unfurls';

const resolveUnfurlsMock = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({
  api: { resolveUnfurls: resolveUnfurlsMock },
}));

beforeEach(() => {
  clearUnfurlResolveCacheForTests();
  resolveUnfurlsMock.mockReset().mockImplementation(async (urls: string[]) => ({
    results: Object.fromEntries(urls.map((url) => [url, { url, kind: 'og', title: url }])),
  }));
});

describe('resolveUnfurls', () => {
  it('batches uncached URLs to the contract limit', async () => {
    const urls = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}`);

    const results = await resolveUnfurls(urls);

    expect(resolveUnfurlsMock).toHaveBeenCalledTimes(2);
    expect(resolveUnfurlsMock.mock.calls[0]?.[0]).toEqual(urls.slice(0, 10));
    expect(resolveUnfurlsMock.mock.calls[1]?.[0]).toEqual(urls.slice(10));
    expect(Object.keys(results)).toEqual(urls);
  });

  it('reuses cached results without another request', async () => {
    const url = 'https://example.com/cached';
    await resolveUnfurls([url]);
    await resolveUnfurls([url]);

    expect(resolveUnfurlsMock).toHaveBeenCalledTimes(1);
  });

  it('permanently caches null results for the session', async () => {
    const url = 'https://example.com/plain';
    resolveUnfurlsMock.mockResolvedValue({ results: { [url]: null } });

    expect(await resolveUnfurls([url])).toEqual({ [url]: null });
    expect(await resolveUnfurls([url])).toEqual({ [url]: null });
    expect(resolveUnfurlsMock).toHaveBeenCalledTimes(1);
  });
});
