import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db, DbClient } from '../db.js';
import {
  foldAnnotations,
  REACTION_EMOJI,
  searchMessages,
  setEntryReactionTx,
  type ReactionAction,
  type UserRef,
} from '../events.js';
import { extractEntryToMarkdownArtifact } from '../entry-extract.js';
import { queryEntryReferences, resolveEntry, tryDecodeHandle } from '../entries.js';
import type { WsHub } from '../hub.js';
import { searchSessionRecords } from '../session-search.js';

export type EntryAnnotationRateLimit =
  | false
  | {
      max: number;
      timeWindow: string;
      hook: 'preHandler';
      keyGenerator(req: FastifyRequest): Promise<string>;
    };

export interface EntryRouteDeps {
  pool: Db;
  hub: WsHub;
  entryAnnotationRateLimit: EntryAnnotationRateLimit;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  optionalOpId(body: unknown): string | undefined;
  canViewFull(userId: string): Promise<boolean>;
  fullViewForbidden(reply: FastifyReply): FastifyReply;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
}

export function registerEntryRoutes(app: FastifyInstance, deps: EntryRouteDeps): void {
  const {
    pool,
    hub,
    entryAnnotationRateLimit,
    requireUser,
    optionalOpId,
    canViewFull,
    fullViewForbidden,
    runMutation,
  } = deps;

  app.get('/api/entries/:handle', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    if (!tryDecodeHandle(handle)) {
      return reply.code(400).send({ error: 'bad_handle' });
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      return reply.code(404).send({ error: 'entry_not_found' });
    }
    return entry;
  });

  app.get('/api/entries/:handle/annotations', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    if (!tryDecodeHandle(handle)) {
      return reply.code(400).send({ error: 'bad_handle' });
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      return reply.code(404).send({ error: 'entry_not_found' });
    }
    return foldAnnotations(pool, handle);
  });

  app.post(
    '/api/entries/references/query',
    { config: { rateLimit: entryAnnotationRateLimit } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const body = (req.body ?? {}) as { handles?: unknown };
      if (!Array.isArray(body.handles)) {
        return reply.code(400).send({ error: 'bad_request', message: 'handles must be an array' });
      }
      if (body.handles.length > 200) {
        return reply.code(400).send({ error: 'too_many_handles', message: 'handles is limited to 200' });
      }
      const handles: string[] = [];
      for (const handle of body.handles) {
        if (typeof handle !== 'string' || !tryDecodeHandle(handle)) {
          return reply.code(400).send({ error: 'bad_handle' });
        }
        handles.push(handle);
      }
      return queryEntryReferences(pool, handles, user.id);
    },
  );

  app.post('/api/entries/:handle/extract', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    if (!tryDecodeHandle(handle)) {
      return reply.code(400).send({ error: 'bad_handle' });
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      return reply.code(404).send({ error: 'entry_not_found' });
    }
    try {
      const result = await extractEntryToMarkdownArtifact(pool, { handle, entry, userId: user.id });
      return reply
        .code(result.created ? 201 : 200)
        .send({
          artifactId: result.artifactId,
          path: result.path,
          seq: result.seq,
          workspaceId: result.workspaceId,
        });
    } catch (err) {
      if ((err as { statusCode?: number; code?: string })?.statusCode === 422) {
        return reply.code(422).send({ error: (err as { code?: string }).code ?? 'unprocessable_entry' });
      }
      throw err;
    }
  });

  app.post(
    '/api/entries/:handle/reactions',
    { config: { rateLimit: entryAnnotationRateLimit } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const { handle } = req.params as { handle: string };
      if (!tryDecodeHandle(handle)) {
        return reply.code(400).send({ error: 'bad_handle' });
      }
      const body = (req.body ?? {}) as { emoji?: string; action?: unknown; opId?: unknown };
      const opId = optionalOpId(body);
      if (typeof body.emoji !== 'string' || !body.emoji) {
        return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
      }
      if (!(REACTION_EMOJI as readonly string[]).includes(body.emoji)) {
        return reply.code(400).send({ error: 'invalid_emoji', message: 'unsupported reaction emoji' });
      }
      if (body.action !== 'add' && body.action !== 'remove') {
        return reply.code(400).send({ error: 'bad_request', message: "action must be 'add' or 'remove'" });
      }
      const entry = await resolveEntry(pool, handle, user.id);
      if (!entry) {
        return reply.code(404).send({ error: 'entry_not_found' });
      }
      return runMutation({
        userId: user.id,
        opId,
        opType: 'entry.reaction.set',
        body: { handle, emoji: body.emoji, action: body.action },
        fn: async (client) => {
          const result = await setEntryReactionTx(client, {
            handle,
            actorId: user.id,
            emoji: body.emoji as string,
            action: body.action as ReactionAction,
          });
          return result.applied ? { event: result.event } : { event: null, applied: false as const };
        },
        onApplied: (response) => {
          if (response.event) hub.publishEvent(response.event);
        },
      });
    },
  );

  app.get('/api/search', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { q?: string; limit?: string };
    const query = String(q.q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'bad_query', message: 'query must be at least 2 chars' });
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric limit expected' });
    }
    return { results: await searchMessages(pool, { query, userId: user.id, limit }) };
  });

  app.get('/api/search/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { q?: string; kinds?: string; full?: string; limit?: string };
    const query = String(q.q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'bad_query', message: 'query must be at least 2 chars' });
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric limit expected' });
    }
    const full = q.full === '1';
    if (full && !(await canViewFull(user.id))) {
      return fullViewForbidden(reply);
    }
    const kinds = q.kinds
      ?.split(',')
      .map((kind) => kind.trim())
      .filter((kind) => kind.length > 0);
    return {
      results: await searchSessionRecords(pool, {
        query,
        userId: user.id,
        kinds: kinds && kinds.length > 0 ? kinds : undefined,
        full,
        limit,
      }),
    };
  });
}
