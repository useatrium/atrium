import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import { EntryReferencesQueryBodySchema } from '@atrium/surface-client/entry-contracts';
import type { AppMutationContext } from '../app-mutations.js';
import type { Db } from '../db.js';
import {
  DomainError,
  foldAnnotations,
  REACTION_EMOJI,
  searchMessages,
  setEntryReactionTx,
  type UserRef,
} from '../events.js';
import { extractEntryToMarkdownArtifact } from '../entry-extract.js';
import { queryEntryReferences, resolveEntry, tryDecodeHandle } from '../entries.js';
import type { WsHub } from '../hub.js';
import { decodeRouteBody, decodeRouteParams, decodeRouteQuery } from '../route-schema.js';
import { searchSessionRecords } from '../session-search.js';

const EntryHandleParamsSchema = Schema.Struct({
  handle: Schema.optional(Schema.Unknown),
});

const EntryReactionBodySchema = Schema.Struct({
  emoji: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

const SearchQuerySchema = Schema.Struct({
  q: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
});

const SessionSearchQuerySchema = Schema.Struct({
  q: Schema.optional(Schema.Unknown),
  kinds: Schema.optional(Schema.String),
  full: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
});

function parseSearchParams(query: { q?: unknown; limit?: unknown }): { query: string; limit: number | undefined } {
  const text = String(query.q ?? '').trim();
  if (text.length < 2) {
    throw new DomainError(400, 'bad_query', 'query must be at least 2 chars');
  }
  const limit = query.limit ? Number(query.limit) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new DomainError(400, 'bad_query', 'numeric limit expected');
  }
  return { query: text, limit };
}

export type EntryAnnotationRateLimit =
  | false
  | {
      max: number;
      timeWindow: string;
      hook: 'preHandler';
      keyGenerator(req: FastifyRequest): Promise<string>;
    };

export interface EntryRouteDeps extends AppMutationContext {
  pool: Db;
  hub: WsHub;
  entryAnnotationRateLimit: EntryAnnotationRateLimit;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  canViewFull(userId: string): Promise<boolean>;
  fullViewForbidden(reply: FastifyReply): FastifyReply;
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

  async function requireEntry(req: FastifyRequest, reply: FastifyReply, user: UserRef) {
    const { handle } = decodeRouteParams(EntryHandleParamsSchema, req.params);
    if (typeof handle !== 'string' || !tryDecodeHandle(handle)) {
      reply.code(400).send({ error: 'bad_handle' });
      return null;
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      reply.code(404).send({ error: 'entry_not_found' });
      return null;
    }
    return { handle, entry };
  }

  app.get('/api/entries/:handle', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const resolved = await requireEntry(req, reply, user);
    return resolved?.entry;
  });

  app.get('/api/entries/:handle/annotations', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const resolved = await requireEntry(req, reply, user);
    if (!resolved) return;
    const { handle } = resolved;
    return foldAnnotations(pool, handle);
  });

  app.post(
    '/api/entries/references/query',
    { config: { rateLimit: entryAnnotationRateLimit } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const body = decodeRouteBody(EntryReferencesQueryBodySchema, req.body);
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
    const resolved = await requireEntry(req, reply, user);
    if (!resolved) return;
    const { handle, entry } = resolved;
    try {
      const result = await extractEntryToMarkdownArtifact(pool, { handle, entry, userId: user.id });
      return reply
        .code(result.created ? 201 : 200)
        .send({
          artifactId: result.artifactId,
          path: result.path,
          seq: result.seq,
          workspaceId: result.workspaceId,
          // The current source text of the entry, so the markup UI can detect when the
          // (persistent, shared) markup artifact has diverged from the live message and
          // offer a reset. Null for artifact entries, whose "text" is just a filename.
          sourceText: entry.targetType === 'artifact' ? null : entry.text,
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
      const body = decodeRouteBody(EntryReactionBodySchema, req.body);
      const opId = optionalOpId(body);
      const emoji = body.emoji;
      if (typeof emoji !== 'string' || !emoji) {
        return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
      }
      if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) {
        return reply.code(400).send({ error: 'invalid_emoji', message: 'unsupported reaction emoji' });
      }
      const action = body.action;
      if (action !== 'add' && action !== 'remove') {
        return reply.code(400).send({ error: 'bad_request', message: "action must be 'add' or 'remove'" });
      }
      const resolved = await requireEntry(req, reply, user);
      if (!resolved) return;
      const { handle } = resolved;
      return runMutation({
        userId: user.id,
        opId,
        opType: 'entry.reaction.set',
        body: { handle, emoji, action },
        fn: async (client) => {
          const result = await setEntryReactionTx(client, {
            handle,
            actorId: user.id,
            emoji,
            action,
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
    const q = decodeRouteQuery(SearchQuerySchema, req.query);
    const { query, limit } = parseSearchParams(q);
    return { results: await searchMessages(pool, { query, userId: user.id, limit }) };
  });

  app.get('/api/search/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = decodeRouteQuery(SessionSearchQuerySchema, req.query);
    const { query, limit } = parseSearchParams(q);
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
