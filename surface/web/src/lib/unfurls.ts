import { UNFURL_RESOLVE_MAX_URLS, type UnfurlResult } from '@atrium/surface-client';
import { api } from '../api';

const resolveCache = new Map<string, Promise<UnfurlResult | null>>();

type Deferred = {
  promise: Promise<UnfurlResult | null>;
  resolve: (result: UnfurlResult | null) => void;
};

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<UnfurlResult | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function resolveUnfurls(urls: string[]): Promise<Record<string, UnfurlResult | null>> {
  const uniqueUrls = [...new Set(urls)];
  const uncached = uniqueUrls.filter((url) => !resolveCache.has(url));

  for (let offset = 0; offset < uncached.length; offset += UNFURL_RESOLVE_MAX_URLS) {
    const batch = uncached.slice(offset, offset + UNFURL_RESOLVE_MAX_URLS);
    const pending = new Map(batch.map((url) => [url, deferred()]));
    for (const [url, request] of pending) resolveCache.set(url, request.promise);

    void api
      .resolveUnfurls(batch)
      .then(({ results }) => {
        for (const [url, request] of pending) request.resolve(results[url] ?? null);
      })
      .catch(() => {
        for (const request of pending.values()) request.resolve(null);
      });
  }

  const resolved = await Promise.all(uniqueUrls.map(async (url) => [url, await resolveCache.get(url)!] as const));
  return Object.fromEntries(resolved);
}

export function clearUnfurlResolveCacheForTests(): void {
  resolveCache.clear();
}
