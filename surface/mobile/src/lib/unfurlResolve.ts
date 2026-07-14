import { UNFURL_RESOLVE_MAX_URLS, type Api, type UnfurlResult } from '@atrium/surface-client';

export type UnfurlResolver = (urls: readonly string[]) => Promise<Record<string, UnfurlResult | null>>;

export function createUnfurlResolver(api: Pick<Api, 'resolveUnfurls'>): UnfurlResolver {
  const cache = new Map<string, Promise<UnfurlResult | null>>();

  return async (urls) => {
    const requested = [...new Set(urls)].slice(0, UNFURL_RESOLVE_MAX_URLS);
    const missing = requested.filter((url) => !cache.has(url));

    if (missing.length > 0) {
      const batch = api
        .resolveUnfurls(missing)
        .then(({ results }) => results)
        .catch(() => ({}) as Record<string, UnfurlResult | null>);

      for (const url of missing) {
        cache.set(
          url,
          batch.then((results) => results[url] ?? null),
        );
      }
    }

    const entries = await Promise.all(requested.map(async (url) => [url, (await cache.get(url)) ?? null] as const));
    return Object.fromEntries(entries);
  };
}
