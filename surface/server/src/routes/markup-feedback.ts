import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import { ArtifactLedger } from '../artifact-ledger.js';
import { normalizeMime } from '../artifact-route-utils.js';
import { writeBackArtifactById } from '../artifact-writeback.js';
import type { Db, DbClient } from '../db.js';
import { DomainError, type UserRef, type WireEvent } from '../events.js';
import {
  composeFeedbackSteer,
  deriveFeedbackIntent,
  hasCriticMarkup,
  sourceEntryHandleFromContent,
  titleFromContent,
  type FeedbackIntent,
} from '../markup-feedback.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';
import { decodeRouteBody, decodeRouteParams } from '../route-schema.js';
import type { SessionRuns } from '../session-runs.js';

export interface MarkupFeedbackRouteDeps {
  pool: Db;
  sessionRuns: SessionRuns;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  optionalOpId(body: unknown): string | undefined;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
  publishEvent(event: WireEvent): void;
}

interface FeedbackBody {
  mode?: unknown;
  content?: unknown;
  baseSeq?: unknown;
  sessionId?: unknown;
  note?: unknown;
  intent?: unknown;
  opId?: unknown;
}

const FeedbackParamsSchema = Schema.Struct({
  artifactId: Schema.optional(Schema.Unknown),
});

const FeedbackBodySchema = Schema.Struct({
  mode: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  baseSeq: Schema.optional(Schema.Unknown),
  sessionId: Schema.optional(Schema.Unknown),
  note: Schema.optional(Schema.Unknown),
  intent: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function parseIntent(value: unknown): FeedbackIntent | null | undefined {
  if (value == null) return undefined;
  if (value === 'response' || value === 'revise') return value;
  return null;
}

export async function registerMarkupFeedbackRoutes(
  app: FastifyInstance,
  deps: MarkupFeedbackRouteDeps,
): Promise<void> {
  const { pool, sessionRuns, requireUser, optionalOpId, runMutation, publishEvent } = deps;
  const ledger = new ArtifactLedger(pool);

  app.post('/api/files/:artifactId/feedback', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { artifactId } = decodeRouteParams(FeedbackParamsSchema, req.params);
    if (typeof artifactId !== 'string' || !isUuid(artifactId)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const body: FeedbackBody = decodeRouteBody(FeedbackBodySchema, req.body);
    const applyMode = body.mode === 'apply';
    if (body.mode != null && !applyMode) {
      return reply.code(400).send({ error: 'bad_request', message: 'mode must be apply when provided' });
    }
    if (typeof body.sessionId !== 'string' || !isUuid(body.sessionId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'sessionId must be a uuid' });
    }
    const opId = optionalOpId(body);
    const sessionId = body.sessionId;

    let explicitIntent: FeedbackIntent | null | undefined;
    let baseSeq = 0;
    if (!applyMode) {
      if (typeof body.content !== 'string') {
        return reply.code(400).send({ error: 'bad_request', message: 'content is required' });
      }
      if (!Number.isInteger(body.baseSeq) || Number(body.baseSeq) < 1) {
        return reply.code(400).send({ error: 'bad_request', message: 'baseSeq must be a positive integer' });
      }
      explicitIntent = parseIntent(body.intent);
      if (explicitIntent === null) {
        return reply.code(400).send({ error: 'bad_request', message: 'intent must be response or revise' });
      }
      if (body.note != null && typeof body.note !== 'string') {
        return reply.code(400).send({ error: 'bad_request', message: 'note must be a string' });
      }
      baseSeq = Number(body.baseSeq);
    }

    const readable = await ledger.artifactReadableByUser(artifactId, user.id);
    if (!readable) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!(await ledger.userCanManageArtifact(artifactId, user.id))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (readable.tombstoned) {
      return reply.code(410).send({ error: 'gone' });
    }
    if (!(await sessionRuns.userCanAccessSession(sessionId, user.id))) {
      return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    }

    const current = await ledger.artifactContentById(artifactId);
    if (!current) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (current.tombstoned || current.kind === 'deleted') {
      return reply.code(410).send({ error: 'gone' });
    }
    if (current.isText !== true) {
      return reply
        .code(415)
        .send({ error: 'binary_not_editable', mediaKind: current.mediaKind ?? 'binary' });
    }

    if (applyMode) {
      if (!current.s3Key) {
        return reply.code(409).send({ error: 'base_not_found', baseSeq: current.seq });
      }
      const markedUpContent = (await getObjectBytes(current.s3Key)).toString('utf8');
      if (!hasCriticMarkup(markedUpContent)) {
        return reply.code(400).send({ error: 'no_markup', message: 'latest version has no markup to apply' });
      }
      const title = titleFromContent(markedUpContent, basename(current.path));
      const sourceEntryHandle = sourceEntryHandleFromContent(markedUpContent);

      try {
        const result = await runMutation({
          userId: user.id,
          opId,
          opType: 'artifact.feedback.apply',
          body: {
            artifactId,
            sessionId,
            mode: 'apply',
          },
          fn: async (client) => {
            const text = composeFeedbackSteer({
              markedUpContent,
              baseContent: markedUpContent,
              path: current.path,
              seq: current.seq,
              baseSeq: current.seq,
              intent: 'revise',
              title,
              sourceEntryHandle,
              status: 'normal',
            });
            const event = await sessionRuns.postUserMessageInTx(client, sessionId, user.id, text);
            return { seq: current.seq, event };
          },
          onApplied: (result) => {
            if (result.event) publishEvent(result.event);
            sessionRuns.afterPostUserMessage(sessionId);
          },
        });

        return reply.send({ seq: result.seq, status: 'normal', steered: true, applied: true });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'provider_auth_required') {
          await sessionRuns.markClaudeAuthMissing(sessionId).catch(() => {});
        }
        throw err;
      }
    }

    const baseVersion = await ledger.resolveVersionByArtifactId(artifactId, { seq: baseSeq });
    if (!baseVersion) {
      return reply.code(409).send({ error: 'base_not_found', baseSeq });
    }
    if (baseVersion.kind === 'deleted' || !baseVersion.s3Key || baseVersion.isText !== true) {
      return reply.code(409).send({ error: 'base_not_found', baseSeq });
    }
    const baseContent = (await getObjectBytes(baseVersion.s3Key)).toString('utf8');
    const intent = explicitIntent ?? deriveFeedbackIntent(baseContent);
    const sourceEntryHandle = sourceEntryHandleFromContent(baseContent);
    const title = titleFromContent(baseContent, basename(current.path));
    const mime = normalizeMime('text/markdown; charset=utf-8');

    try {
      const result = await runMutation({
        userId: user.id,
        opId,
        opType: 'artifact.feedback',
        body: {
          artifactId,
          sessionId,
          baseSeq,
          content: body.content,
          intent,
          ...(body.note ? { note: body.note } : {}),
        },
        fn: async (client) => {
          const write = await writeBackArtifactById({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            artifactId,
            bytes: Buffer.from(body.content as string, 'utf8'),
            mime,
            author: `human:${user.id}`,
            baseSeq,
          });
          if (!write.ok) {
            if (write.reason === 'gone') throw new DomainError(410, 'gone', 'artifact was deleted');
            if (write.reason === 'binary_not_editable') {
              throw new DomainError(415, 'binary_not_editable', 'artifact is not editable text');
            }
            throw new DomainError(409, write.reason, write.reason);
          }

          const text = composeFeedbackSteer({
            markedUpContent: body.content as string,
            baseContent,
            path: current.path,
            seq: write.seq,
            baseSeq,
            intent,
            title,
            sourceEntryHandle,
            note: typeof body.note === 'string' ? body.note : undefined,
            status: write.status,
          });
          const event = await sessionRuns.postUserMessageInTx(client, sessionId, user.id, text);
          return {
            seq: write.seq,
            status: write.status as 'normal' | 'conflict',
            steered: true as const,
            event,
          };
        },
        onApplied: (result) => {
          if (result.event) publishEvent(result.event);
          sessionRuns.afterPostUserMessage(sessionId);
        },
      });

      return reply.send({ seq: result.seq, status: result.status, steered: true });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await sessionRuns.markClaudeAuthMissing(sessionId).catch(() => {});
      }
      throw err;
    }
  });
}
