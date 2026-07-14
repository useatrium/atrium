import { promises as dns } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';

const HEADERS_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export const UNFURL_HTML_MAX_BYTES = 512 * 1024;
export const UNFURL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface SafeFetchOptions {
  maxBytes: number;
}

export interface SafeFetchResult {
  body: Buffer;
  contentType: string;
  finalUrl: string;
  status: number;
}

function privateAccessEnabled(): boolean {
  // DANGER: test/dev escape hatch only. Never enable this in production: it
  // disables both private-address and port protections for user-supplied URLs.
  return process.env.ATRIUM_UNFURL_ALLOW_PRIVATE === '1';
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0;
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function parseIpv6(address: string): number[] | null {
  const zoneAt = address.indexOf('%');
  const input = (zoneAt === -1 ? address : address.slice(0, zoneAt)).toLowerCase();
  if (isIP(input) !== 6) return null;
  const [leftRaw, rightRaw] = input.split('::');
  if (input.split('::').length > 2) return null;
  const expand = (part: string | undefined): number[] => {
    if (!part) return [];
    return part.split(':').flatMap((piece) => {
      if (!piece.includes('.')) return [Number.parseInt(piece, 16)];
      const v4 = ipv4Number(piece);
      return v4 === null ? [] : [v4 >>> 16, v4 & 0xffff];
    });
  };
  const left = expand(leftRaw);
  const right = expand(rightRaw);
  const missing = 8 - left.length - right.length;
  const words = input.includes('::') ? [...left, ...Array(missing).fill(0), ...right] : left;
  return words.length === 8 ? words : null;
}

function ipv6Prefix(words: number[], prefixWords: number[], prefixBits: number): boolean {
  const whole = Math.floor(prefixBits / 16);
  const rest = prefixBits % 16;
  for (let i = 0; i < whole; i += 1) if (words[i] !== prefixWords[i]) return false;
  if (rest === 0) return true;
  const mask = (0xffff << (16 - rest)) & 0xffff;
  return ((words[whole] ?? 0) & mask) === ((prefixWords[whole] ?? 0) & mask);
}

/** Exported so the complete deny-list can be tested without making network calls. */
export function isPublicUnfurlAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    const denied: Array<[number, number]> = [
      [0x00000000, 8],
      [0x7f000000, 8],
      [0x0a000000, 8],
      [0xac100000, 12],
      [0xc0a80000, 16],
      [0xa9fe0000, 16],
      [0x64400000, 10],
      [0xc0000000, 24],
      [0xc6120000, 15],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ];
    return !denied.some(([base, prefix]) => inV4Range(v4, base, prefix));
  }

  const words = parseIpv6(address);
  if (!words) return false;
  if (words.every((word) => word === 0) || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) {
    return false;
  }
  if (ipv6Prefix(words, [0xfc00], 7) || ipv6Prefix(words, [0xfe80], 10) || ipv6Prefix(words, [0xff00], 8)) {
    return false;
  }
  const mappedV4 = ipv6Prefix(words, [0, 0, 0, 0, 0, 0xffff], 96);
  const nat64 = ipv6Prefix(words, [0x0064, 0xff9b, 0, 0, 0, 0], 96);
  if (mappedV4 || nat64) {
    const embedded = (((words[6] ?? 0) << 16) | (words[7] ?? 0)) >>> 0;
    return isPublicUnfurlAddress(
      `${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`,
    );
  }
  return true;
}

export function validateUnfurlUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  if (url.username || url.password) throw new Error('URL credentials are forbidden');
  if (!privateAccessEnabled()) {
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) throw new Error('unsupported port');
  }
  return url;
}

export function validateResolvedUnfurlAddresses(addresses: LookupAddress[]): LookupAddress[] {
  if (addresses.length === 0) throw new Error('hostname did not resolve');
  if (!privateAccessEnabled() && addresses.some(({ address }) => !isPublicUnfurlAddress(address))) {
    throw new Error('hostname resolves to a forbidden address');
  }
  return addresses;
}

async function pinnedAddresses(hostname: string, deadline: number): Promise<LookupAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily) return validateResolvedUnfurlAddresses([{ address: hostname, family: literalFamily as 4 | 6 }]);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('unfurl total timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('unfurl total timeout')), remaining);
      }),
    ]);
    return validateResolvedUnfurlAddresses(addresses);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pinnedLookup(addresses: LookupAddress[]) {
  function lookup(
    _hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback:
      | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
      | ((err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void),
  ): void {
    if ('all' in options && options.all) {
      (callback as (err: NodeJS.ErrnoException | null, values: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const first = addresses[0]!;
    (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      first.address,
      first.family,
    );
  }
  return lookup;
}

async function fetchOnce(
  url: URL,
  maxBytes: number,
  deadline: number,
): Promise<SafeFetchResult & { location?: string }> {
  const addresses = await pinnedAddresses(url.hostname, deadline);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('unfurl total timeout');

  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { accept: 'text/html,image/*;q=0.9,*/*;q=0.1', 'user-agent': 'Atrium-Unfurl/1.0' },
      lookup: pinnedLookup(addresses),
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      clearTimeout(totalTimer);
      request.destroy();
      reject(error);
    };
    const headersTimer = setTimeout(
      () => fail(new Error('unfurl headers timeout')),
      Math.min(HEADERS_TIMEOUT_MS, remaining),
    );
    const totalTimer = setTimeout(() => fail(new Error('unfurl total timeout')), remaining);

    request.on('error', fail);
    request.on('response', (response) => {
      clearTimeout(headersTimer);
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          fail(new Error('unfurl response exceeds byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve({
          body: Buffer.concat(chunks),
          contentType: String(response.headers['content-type'] ?? '')
            .split(';', 1)[0]!
            .trim()
            .toLowerCase(),
          finalUrl: url.href,
          location: typeof response.headers.location === 'string' ? response.headers.location : undefined,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const seen = new Set<string>();
  let url = validateUnfurlUrl(rawUrl);

  for (let redirects = 0; ; redirects += 1) {
    const normalized = url.href;
    if (seen.has(normalized)) throw new Error('redirect loop');
    seen.add(normalized);
    const response = await fetchOnce(url, options.maxBytes, deadline);
    if (response.status < 300 || response.status >= 400 || !response.location) return response;
    if (redirects >= MAX_REDIRECTS) throw new Error('too many redirects');
    url = validateUnfurlUrl(new URL(response.location, url).href);
  }
}
