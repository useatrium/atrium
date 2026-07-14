import { createHash } from 'node:crypto';
import {
  isUnfurlableUrl,
  UNFURL_RESOLVE_MAX_URLS,
  type UnfurlResolveResponse,
  type UnfurlResult,
} from '@atrium/surface-client/unfurl-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { extractUnfurl } from '../unfurl/extract.js';
import { safeFetch, UNFURL_HTML_MAX_BYTES, UNFURL_IMAGE_MAX_BYTES } from '../unfurl/safe-fetch.js';

const OK_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 60 * 1000;
const REQUEST_CONCURRENCY = 3;
const USER_IN_FLIGHT_LIMIT = 10;

interface UnfurlRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

interface CacheRow {
  status: 'ok' | 'error';
  result: UnfurlResult | null;
  fetched_at: Date;
}

const userInFlight = new Map<string, number>();

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function fresh(row: CacheRow): boolean {
  const ttl = row.status === 'ok' ? OK_TTL_MS : ERROR_TTL_MS;
  return Date.now() - new Date(row.fetched_at).getTime() < ttl;
}

async function store(pool: Db, url: string, result: UnfurlResult | null): Promise<void> {
  await pool.query(
    `INSERT INTO link_unfurls (url_hash, url, status, result, fetched_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (url_hash) DO UPDATE
       SET url = EXCLUDED.url, status = EXCLUDED.status, result = EXCLUDED.result, fetched_at = now()`,
    [hashUrl(url), url, result ? 'ok' : 'error', result ? JSON.stringify(result) : null],
  );
}

async function fetchMetadata(url: string): Promise<UnfurlResult | null> {
  const response = await safeFetch(url, { maxBytes: UNFURL_HTML_MAX_BYTES });
  if (response.status < 200 || response.status >= 300) return null;
  return extractUnfurl(response.finalUrl, response.contentType, response.body);
}

async function limitedMap<T>(items: string[], worker: (item: string) => Promise<T>): Promise<Map<string, T>> {
  const output = new Map<string, T>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(REQUEST_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        output.set(item, await worker(item));
      }
    }),
  );
  return output;
}

export function registerUnfurlRoutes(app: FastifyInstance, deps: UnfurlRouteDeps): void {
  const { pool, requireUser } = deps;

  app.post('/api/unfurl/resolve', async (req, reply): Promise<UnfurlResolveResponse | undefined> => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = req.body as { urls?: unknown } | null;
    if (
      !body ||
      !Array.isArray(body.urls) ||
      body.urls.length > UNFURL_RESOLVE_MAX_URLS ||
      body.urls.some((url) => typeof url !== 'string')
    ) {
      reply
        .code(400)
        .send({ error: 'bad_request', message: `urls must be an array of at most ${UNFURL_RESOLVE_MAX_URLS} strings` });
      return;
    }

    const requested = body.urls as string[];
    const uniqueValid = [...new Set(requested.filter(isUnfurlableUrl))];
    const cached = new Map<string, UnfurlResult | null>();
    const misses: string[] = [];
    if (uniqueValid.length > 0) {
      const hashes = uniqueValid.map(hashUrl);
      const rows = await pool.query<CacheRow & { url_hash: string }>(
        'SELECT url_hash, status, result, fetched_at FROM link_unfurls WHERE url_hash = ANY($1)',
        [hashes],
      );
      const byHash = new Map(rows.rows.map((row) => [row.url_hash, row]));
      for (const url of uniqueValid) {
        const row = byHash.get(hashUrl(url));
        if (row && fresh(row)) cached.set(url, row.status === 'ok' ? row.result : null);
        else misses.push(url);
      }
    }

    const fetched = await limitedMap(misses, async (url) => {
      const count = userInFlight.get(user.id) ?? 0;
      if (count >= USER_IN_FLIGHT_LIMIT) return null;
      userInFlight.set(user.id, count + 1);
      let result: UnfurlResult | null = null;
      try {
        result = await fetchMetadata(url);
      } catch {}
      try {
        await store(pool, url, result);
      } catch (error) {
        app.log.warn({ err: error, url }, 'failed to cache unfurl result');
      } finally {
        const remaining = (userInFlight.get(user.id) ?? 1) - 1;
        if (remaining <= 0) userInFlight.delete(user.id);
        else userInFlight.set(user.id, remaining);
      }
      return result;
    });

    const results: UnfurlResolveResponse['results'] = {};
    for (const url of requested) {
      results[url] = isUnfurlableUrl(url) ? (cached.get(url) ?? fetched.get(url) ?? null) : null;
    }
    return { results };
  });

  app.get('/api/unfurl/image', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const url = (req.query as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !isUnfurlableUrl(url)) {
      return reply.code(400).send({ error: 'bad_request', message: 'a valid http(s) url is required' });
    }
    // Same per-user in-flight ceiling as resolve: every request here is an
    // outbound fetch of a user-controlled URL, so it must not be unbounded.
    const inFlight = userInFlight.get(user.id) ?? 0;
    if (inFlight >= USER_IN_FLIGHT_LIMIT) {
      return reply.code(429).send({ error: 'too_many_requests', message: 'too many concurrent unfurl fetches' });
    }
    userInFlight.set(user.id, inFlight + 1);
    let response: Awaited<ReturnType<typeof safeFetch>>;
    try {
      response = await safeFetch(url, { maxBytes: UNFURL_IMAGE_MAX_BYTES });
    } catch {
      return reply.code(502).send({ error: 'image_fetch_failed', message: 'image could not be fetched' });
    } finally {
      const remaining = (userInFlight.get(user.id) ?? 1) - 1;
      if (remaining <= 0) userInFlight.delete(user.id);
      else userInFlight.set(user.id, remaining);
    }
    if (response.status < 200 || response.status >= 300) {
      return reply.code(502).send({ error: 'image_fetch_failed', message: 'image could not be fetched' });
    }
    if (!response.contentType.startsWith('image/')) {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'upstream response is not an image' });
    }
    return reply
      .header('content-type', response.contentType)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(response.body);
  });
}
