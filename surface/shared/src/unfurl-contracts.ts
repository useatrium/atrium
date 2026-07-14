/**
 * Contract for external-link unfurls (rich previews of http(s) URLs in chat
 * messages). The server fetches and caches metadata via an SSRF-hardened
 * fetcher; clients batch-resolve visible URLs and render OG cards or inline
 * images. Suppression reuses the message.unfurls_suppressed machinery with
 * the absolute URL string as the suppression key.
 */

/** How a resolved URL should be presented. */
export type UnfurlKind = 'og' | 'image';

export interface UnfurlResult {
  url: string;
  kind: UnfurlKind;
  /** Page title (og:title / twitter:title / <title>). Absent for kind:'image'. */
  title?: string;
  /** og:description / twitter:description / meta description. */
  description?: string;
  /**
   * Preview image. For kind:'image' this is the URL itself. Clients must load
   * it through `unfurlImageProxyUrl` — never hotlink the external host.
   */
  imageUrl?: string;
  /** og:site_name, else the URL's hostname. */
  siteName?: string;
  /** Intrinsic image dimensions when known (image content only). */
  width?: number;
  height?: number;
}

/**
 * POST /api/unfurl/resolve response. URLs that could not be unfurled (fetch
 * error, private address, non-OG/non-image content, size/time caps) map to
 * null — clients render those as plain links, silently.
 */
export interface UnfurlResolveResponse {
  results: Record<string, UnfurlResult | null>;
}

/** Max URLs per resolve call; clients slice before requesting. */
export const UNFURL_RESOLVE_MAX_URLS = 10;

/**
 * Server-side image proxy for preview images (prevents leaking viewer IPs to
 * external hosts and dodges mixed-content). Same SSRF guards + size caps as
 * the metadata fetcher.
 */
export function unfurlImageProxyUrl(imageUrl: string): string {
  return `/api/unfurl/image?url=${encodeURIComponent(imageUrl)}`;
}

/**
 * True for absolute http(s) URLs that are candidates for external unfurling.
 * Entry-ref URLs (`/e/<handle>` on any host) are handled by the entry-quote
 * pipeline and must be excluded by callers before resolving.
 */
export function isUnfurlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return true;
}
