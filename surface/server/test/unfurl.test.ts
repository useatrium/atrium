import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { extractUnfurl } from '../src/unfurl/extract.js';
import {
  isPublicUnfurlAddress,
  safeFetch,
  UNFURL_HTML_MAX_BYTES,
  validateResolvedUnfurlAddresses,
  validateUnfurlUrl,
} from '../src/unfurl/safe-fetch.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

let fixtureServer: Server;
let fixtureBase: string;
let fixtureHits = new Map<string, number>();
let activeSlowRequests = 0;
let maxActiveSlowRequests = 0;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;

beforeAll(async () => {
  fixtureServer = createServer((req, res) => {
    const path = req.url ?? '/';
    fixtureHits.set(path, (fixtureHits.get(path) ?? 0) + 1);
    if (path === '/og') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta property="og:title" content="Tea &amp; Biscuits">
        <meta name='og:description' content='A friendly &quot;page&quot;'>
        <meta content="/image" property="og:image"><meta property="og:site_name" content="Fixture">`);
    } else if (path === '/title') {
      res.setHeader('content-type', 'text/html');
      res.end('<title>Only a title</title>');
    } else if (path === '/image') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (path === '/plain') {
      res.setHeader('content-type', 'text/plain');
      res.end('plain');
    } else if (/^\/r[1-4]$/.test(path)) {
      const hops = Number(path.slice(2));
      res.statusCode = 302;
      res.setHeader('location', hops === 1 ? '/og' : `/r${hops - 1}`);
      res.end();
    } else if (path === '/loop-a' || path === '/loop-b') {
      res.statusCode = 302;
      res.setHeader('location', path === '/loop-a' ? '/loop-b' : '/loop-a');
      res.end();
    } else if (path === '/credential-redirect') {
      res.statusCode = 302;
      res.setHeader('location', fixtureBase.replace('http://', 'http://user:secret@'));
      res.end();
    } else if (path === '/own-origin-redirect') {
      res.statusCode = 302;
      res.setHeader('location', `${fixtureBase}/og`);
      res.end();
    } else if (path === '/large') {
      res.setHeader('content-type', 'text/html');
      let sent = 0;
      const timer = setInterval(() => {
        sent += 64 * 1024;
        if (sent > UNFURL_HTML_MAX_BYTES + 64 * 1024) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(Buffer.alloc(64 * 1024, 97));
        }
      }, 5);
      res.on('close', () => clearInterval(timer));
    } else if (path === '/large-image') {
      res.setHeader('content-type', 'image/png');
      let sent = 0;
      const timer = setInterval(() => {
        sent += 512 * 1024;
        if (sent > 6 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(Buffer.alloc(512 * 1024));
        }
      }, 2);
      res.on('close', () => clearInterval(timer));
    } else if (path === '/headers-timeout') {
      // Intentionally never sends headers. The client must destroy the socket.
    } else if (path === '/total-timeout') {
      res.setHeader('content-type', 'text/html');
      const timer = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(timer));
    } else if (path.startsWith('/slow/')) {
      activeSlowRequests += 1;
      maxActiveSlowRequests = Math.max(maxActiveSlowRequests, activeSlowRequests);
      setTimeout(() => {
        activeSlowRequests -= 1;
        res.setHeader('content-type', 'text/html');
        res.end(`<title>${path}</title>`);
      }, 200);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureBase = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  pool = await createTestPool();
});

afterAll(async () => {
  delete process.env.ATRIUM_UNFURL_ALLOW_PRIVATE;
  config.publicOrigin = '';
  await pool.end();
  await new Promise<void>((resolve, reject) => fixtureServer.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  process.env.ATRIUM_UNFURL_ALLOW_PRIVATE = '1';
  config.publicOrigin = '';
  fixtureHits = new Map();
  activeSlowRequests = 0;
  maxActiveSlowRequests = 0;
  await truncateAll(pool);
  await pool.query('DELETE FROM link_unfurls');
  await seedFixture(pool);
  app = await buildApp({
    pool,
    rateLimit: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  cookie = login.headers['set-cookie'] as string;
});

afterEach(async () => {
  process.env.ATRIUM_UNFURL_ALLOW_PRIVATE = '1';
  config.publicOrigin = '';
  await app.close();
});

async function resolve(urls: string[]) {
  return app.inject({ method: 'POST', url: '/api/unfurl/resolve', headers: { cookie }, payload: { urls } });
}

describe('unfurl extraction and safe fetch', () => {
  it('extracts OG fields, entity-decodes, and resolves relative images', () => {
    const result = extractUnfurl(
      'https://example.com/path/page',
      'text/html',
      Buffer.from(`<meta content='/preview.png' property='og:image'><meta property='og:title' content='A &amp; B'>
        <meta name='twitter:description' content='Fallback &#x26; detail'>`),
    );
    expect(result).toEqual({
      url: 'https://example.com/path/page',
      kind: 'og',
      title: 'A & B',
      description: 'Fallback & detail',
      imageUrl: 'https://example.com/preview.png',
      siteName: 'example.com',
    });
  });

  it('drops invalid preview images and requires a title', () => {
    expect(
      extractUnfurl('https://example.com', 'text/html', Buffer.from('<meta property="og:image" content="file:///x">')),
    ).toBeNull();
  });

  it('follows two redirects but rejects four redirects and loops', async () => {
    await expect(safeFetch(`${fixtureBase}/r2`, { maxBytes: UNFURL_HTML_MAX_BYTES })).resolves.toMatchObject({
      finalUrl: `${fixtureBase}/og`,
    });
    await expect(safeFetch(`${fixtureBase}/r4`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow(
      'too many redirects',
    );
    await expect(safeFetch(`${fixtureBase}/loop-a`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow(
      'redirect loop',
    );
  });

  it('revalidates redirect targets and rejects credentials at a later hop', async () => {
    await expect(safeFetch(`${fixtureBase}/credential-redirect`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow(
      'credentials',
    );
  });

  it('rejects the configured public origin', async () => {
    config.publicOrigin = fixtureBase;
    await expect(safeFetch(`${fixtureBase}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow('own origin');
    expect(fixtureHits.get('/og')).toBeUndefined();
  });

  it('rejects the configured public origin on a redirect hop', async () => {
    config.publicOrigin = fixtureBase;
    const externalOrigin = fixtureBase.replace('127.0.0.1', 'localhost');
    await expect(
      safeFetch(`${externalOrigin}/own-origin-redirect`, { maxBytes: UNFURL_HTML_MAX_BYTES }),
    ).rejects.toThrow('own origin');
    expect(fixtureHits.get('/own-origin-redirect')).toBe(1);
    expect(fixtureHits.get('/og')).toBeUndefined();
  });

  it('still unfurls an unrelated origin when the guard is configured', async () => {
    config.publicOrigin = 'https://atrium.example';
    await expect(safeFetch(`${fixtureBase}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES })).resolves.toMatchObject({
      status: 200,
      finalUrl: `${fixtureBase}/og`,
    });
  });

  it('leaves the guard inactive when the public origin is unset', async () => {
    config.publicOrigin = '';
    await expect(safeFetch(`${fixtureBase}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('does not let the private-address escape hatch disable the own-origin guard', async () => {
    process.env.ATRIUM_UNFURL_ALLOW_PRIVATE = '1';
    config.publicOrigin = fixtureBase;
    await expect(safeFetch(`${fixtureBase}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow('own origin');
    expect(fixtureHits.get('/og')).toBeUndefined();
  });

  it('aborts a streamed body beyond the hard cap', async () => {
    await expect(safeFetch(`${fixtureBase}/large`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow('byte limit');
  });

  it('enforces connect/headers and total deadlines', async () => {
    const started = Date.now();
    const [headers, total] = await Promise.allSettled([
      safeFetch(`${fixtureBase}/headers-timeout`, { maxBytes: UNFURL_HTML_MAX_BYTES }),
      safeFetch(`${fixtureBase}/total-timeout`, { maxBytes: UNFURL_HTML_MAX_BYTES }),
    ]);
    expect(headers).toMatchObject({ status: 'rejected', reason: { message: 'unfurl headers timeout' } });
    expect(total).toMatchObject({ status: 'rejected', reason: { message: 'unfurl total timeout' } });
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 10_000);
});

describe('SSRF address and URL policy', () => {
  it.each([
    '0.0.0.0',
    '0.255.255.255',
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fdff::1',
    'fe80::1',
    'febf::1',
    'ff00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
  ])('rejects forbidden address %s', (address) => {
    expect(isPublicUnfurlAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows public address %s, including safe mapped forms', (address) =>
    expect(isPublicUnfurlAddress(address)).toBe(true));

  it('rejects non-http protocols, credentials, and nonstandard ports', () => {
    delete process.env.ATRIUM_UNFURL_ALLOW_PRIVATE;
    expect(() => validateUnfurlUrl('file:///etc/passwd')).toThrow('protocol');
    expect(() => validateUnfurlUrl('https://user:secret@example.com')).toThrow('credentials');
    expect(() => validateUnfurlUrl('https://example.com:8443')).toThrow('port');
    expect(validateUnfurlUrl('http://example.com:443').port).toBe('443');
  });

  it('rejects a DNS answer set if any address is private', () => {
    delete process.env.ATRIUM_UNFURL_ALLOW_PRIVATE;
    expect(() =>
      validateResolvedUnfurlAddresses([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).toThrow('forbidden address');
  });

  it('connects through the validated custom lookup for a hostname', async () => {
    await expect(
      safeFetch(`${fixtureBase.replace('127.0.0.1', 'localhost')}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('rejects loopback end-to-end when the dangerous test/dev flag is off', async () => {
    delete process.env.ATRIUM_UNFURL_ALLOW_PRIVATE;
    await expect(safeFetch(`${fixtureBase}/og`, { maxBytes: UNFURL_HTML_MAX_BYTES })).rejects.toThrow(
      /unsupported port|forbidden address/,
    );
    expect(fixtureHits.get('/og')).toBeUndefined();
  });
});

describe('unfurl routes', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/unfurl/resolve', payload: { urls: [] } });
    expect(response.statusCode).toBe(401);
  });

  it('returns the existing silent null result for the configured public origin', async () => {
    config.publicOrigin = fixtureBase;
    const url = `${fixtureBase}/og`;
    const response = await resolve([url]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[url]).toBeNull();
    expect(fixtureHits.get('/og')).toBeUndefined();
  });

  it('rejects malformed or oversized batches', async () => {
    expect((await resolve(Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`))).statusCode).toBe(
      400,
    );
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/unfurl/resolve',
      headers: { cookie },
      payload: { urls: 'no' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('resolves OG, title-only, image, plain, and invalid URLs to the contract shape', async () => {
    const urls = [
      `${fixtureBase}/og`,
      `${fixtureBase}/title`,
      `${fixtureBase}/image`,
      `${fixtureBase}/plain`,
      'file:///bad',
    ];
    const response = await resolve(urls);
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual({
      [urls[0]!]: {
        url: urls[0],
        kind: 'og',
        title: 'Tea & Biscuits',
        description: 'A friendly "page"',
        imageUrl: `${fixtureBase}/image`,
        siteName: 'Fixture',
      },
      [urls[1]!]: { url: urls[1], kind: 'og', title: 'Only a title', siteName: '127.0.0.1' },
      [urls[2]!]: { url: urls[2], kind: 'image', imageUrl: urls[2] },
      [urls[3]!]: null,
      'file:///bad': null,
    });
  });

  it('deduplicates URLs and serves fresh cache entries without refetching', async () => {
    const url = `${fixtureBase}/og`;
    expect((await resolve([url, url])).statusCode).toBe(200);
    expect(fixtureHits.get('/og')).toBe(1);
    expect((await resolve([url])).statusCode).toBe(200);
    expect(fixtureHits.get('/og')).toBe(1);
  });

  it('refetches stale cache rows', async () => {
    const url = `${fixtureBase}/og`;
    await resolve([url]);
    await pool.query("UPDATE link_unfurls SET fetched_at = now() - interval '25 hours'");
    await resolve([url]);
    expect(fixtureHits.get('/og')).toBe(2);
  });

  it('caches failures for one hour and refetches them once stale', async () => {
    const url = `${fixtureBase}/plain`;
    await resolve([url]);
    await resolve([url]);
    expect(fixtureHits.get('/plain')).toBe(1);
    await pool.query("UPDATE link_unfurls SET fetched_at = now() - interval '61 minutes'");
    await resolve([url]);
    expect(fixtureHits.get('/plain')).toBe(2);
  });

  it('limits each request to three concurrent external fetches', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `${fixtureBase}/slow/${index}`);
    const response = await resolve(urls);
    expect(response.statusCode).toBe(200);
    expect(maxActiveSlowRequests).toBe(3);
  });

  it('caps concurrent external fetches per user without queueing beyond ten', async () => {
    const calls = Array.from({ length: 4 }, (_, group) =>
      resolve(Array.from({ length: 3 }, (_, index) => `${fixtureBase}/slow/${group}-${index}`)),
    );
    const responses = await Promise.all(calls);
    const values = responses.flatMap((response) => Object.values(response.json().results));
    expect(values.filter((value) => value === null)).toHaveLength(2);
    expect([...fixtureHits.keys()].filter((path) => path.startsWith('/slow/'))).toHaveLength(10);
  });

  it('follows valid redirects and converts redirect/body-limit failures to null', async () => {
    const urls = [`${fixtureBase}/r2`, `${fixtureBase}/r4`, `${fixtureBase}/loop-a`, `${fixtureBase}/large`];
    const response = await resolve(urls);
    expect(response.json().results[urls[0]!]).toMatchObject({ kind: 'og', title: 'Tea & Biscuits' });
    expect(response.json().results[urls[1]!]).toBeNull();
    expect(response.json().results[urls[2]!]).toBeNull();
    expect(response.json().results[urls[3]!]).toBeNull();
  });

  it('proxies images with defensive headers and rejects non-images', async () => {
    const image = await app.inject({
      method: 'GET',
      url: `/api/unfurl/image?url=${encodeURIComponent(`${fixtureBase}/image`)}`,
      headers: { cookie },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe('private, max-age=86400');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const plain = await app.inject({
      method: 'GET',
      url: `/api/unfurl/image?url=${encodeURIComponent(`${fixtureBase}/plain`)}`,
      headers: { cookie },
    });
    expect(plain.statusCode).toBe(415);

    const oversized = await app.inject({
      method: 'GET',
      url: `/api/unfurl/image?url=${encodeURIComponent(`${fixtureBase}/large-image`)}`,
      headers: { cookie },
    });
    expect(oversized.statusCode).toBe(502);
  });
});
