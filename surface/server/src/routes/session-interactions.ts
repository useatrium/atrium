import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import { DomainError, type UserRef, type WireEvent } from '../events.js';
import {
  isSessionEffortLevel,
  type QuestionAnswerBody,
  type SessionEffortLevel,
  type SessionRuns,
} from '../session-runs.js';

export interface SessionInteractionRouteDeps {
  sessionRuns: SessionRuns;
  maxMessageBytes: number;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
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

function isAnswerBody(value: unknown): value is QuestionAnswerBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const answers = (entry as { answers?: unknown }).answers;
    if (!Array.isArray(answers) || !answers.every((answer) => typeof answer === 'string')) {
      return false;
    }
  }
  return true;
}

function isQuestionNotPendingError(err: unknown): boolean {
  return err instanceof DomainError && err.code === 'question_not_pending';
}

export function registerSessionInteractionRoutes(app: FastifyInstance, deps: SessionInteractionRouteDeps): void {
  const { sessionRuns, maxMessageBytes, requireUser, requireSessionAccess, optionalOpId, runMutation, publishEvent } =
    deps;

  app.get('/api/sessions/:id/stream', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { after_event_id?: string };
    const afterEventId = q.after_event_id == null ? 0 : Number(q.after_event_id);
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'after_event_id must be a nonnegative integer' });
    }
    const session = await sessionRuns.getSessionForUser(id, user.id);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    await sessionRuns.streamCentaurEvents(session, user.id, afterEventId, reply.raw, abort.signal);
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; effort?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    if (body.effort !== undefined && !isSessionEffortLevel(body.effort)) {
      return reply.code(400).send({ error: 'invalid_effort', message: 'unknown effort level' });
    }
    const effort = body.effort as SessionEffortLevel | undefined;
    try {
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.steer',
        body: { sessionId: id, text, ...(effort ? { effort } : {}) },
        fn: async (client) => {
          const event = await sessionRuns.postUserMessageInTx(client, id, user.id, text, effort);
          return { ok: true as const, event };
        },
        onApplied: (result) => {
          if (result.event) publishEvent(result.event);
          sessionRuns.afterPostUserMessage(id);
        },
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await sessionRuns.markClaudeAuthMissing(id).catch(() => {});
      }
      throw err;
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/answer', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { questionId?: unknown; answers?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.questionId !== 'string' || !isAnswerBody(body.answers)) {
      return reply.code(400).send({ error: 'bad_request', message: 'questionId and answers are required' });
    }
    const questionId = body.questionId;
    const answers = body.answers;
    if (opId) {
      let event: WireEvent | null = null;
      try {
        await runMutation({
          userId: user.id,
          opId,
          opType: 'session.answer',
          body: { sessionId: id, questionId, answers },
          fn: async (client) => {
            event = await sessionRuns.answerQuestionInTx(client, id, user, questionId, answers);
            return { ok: true as const };
          },
          onApplied: () => {
            if (event) publishEvent(event);
          },
        });
      } catch (err) {
        if (isQuestionNotPendingError(err)) {
          await sessionRuns.clearStalePendingQuestion(id, body.questionId);
        }
        throw err;
      }
    } else {
      await sessionRuns.answerQuestion(id, user, questionId, answers);
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/request', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.requestSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/grant', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userId?: string };
    if (!body.userId || typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    await sessionRuns.grantSeat(id, user.id, body.userId);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/take', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.takeSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/suggestions', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'suggestion text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'suggestion exceeds 8KB' });
    }
    let event: WireEvent | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.suggestion.create',
      body: { sessionId: id, text },
      fn: async (client) => {
        event = await sessionRuns.createSuggestionInTx(client, id, user.id, text);
        return { ok: true as const };
      },
      onApplied: () => {
        if (event) publishEvent(event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/suggestions/:suggestionId/resolve', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id, suggestionId } = req.params as { id: string; suggestionId: string };
    if (!/^[0-9a-f-]{36}$/i.test(suggestionId)) {
      return reply.code(404).send({ error: 'suggestion_not_found', message: 'suggestion not found' });
    }
    const body = (req.body ?? {}) as { action?: unknown; text?: unknown; note?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (body.action !== 'send' && body.action !== 'dismiss') {
      return reply.code(400).send({ error: 'bad_request', message: "action must be 'send' or 'dismiss'" });
    }
    const action = body.action;
    const text = action === 'send' && typeof body.text === 'string' ? body.text : undefined;
    const note = action === 'dismiss' && typeof body.note === 'string' ? body.note : undefined;
    if (text !== undefined && Buffer.byteLength(text, 'utf8') > maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    let result: { event: WireEvent; postedSteer: boolean } | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.suggestion.resolve',
      body: {
        sessionId: id,
        suggestionId,
        action,
        ...(text !== undefined ? { text } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      fn: async (client) => {
        result = await sessionRuns.resolveSuggestionInTx(client, id, user.id, suggestionId, action, { text, note });
        return { ok: true as const };
      },
      onApplied: () => {
        if (!result) return;
        if (result.postedSteer) sessionRuns.afterPostUserMessage(id);
        publishEvent(result.event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/question-proposals', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { questionId?: unknown; answers?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.questionId !== 'string' || !isAnswerBody(body.answers)) {
      return reply.code(400).send({ error: 'bad_request', message: 'questionId and answers are required' });
    }
    const questionId = body.questionId;
    const answers = body.answers;
    let event: WireEvent | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.answer.propose',
      body: { sessionId: id, questionId, answers },
      fn: async (client) => {
        event = await sessionRuns.createAnswerProposalInTx(client, id, user.id, questionId, answers);
        return { ok: true as const };
      },
      onApplied: () => {
        if (event) publishEvent(event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/question-proposals/:proposalId/resolve', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) {
      return reply.code(404).send({ error: 'proposal_not_found', message: 'proposal not found' });
    }
    const body = (req.body ?? {}) as { action?: unknown; note?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (body.action !== 'submit' && body.action !== 'dismiss') {
      return reply.code(400).send({ error: 'bad_request', message: "action must be 'submit' or 'dismiss'" });
    }
    const action = body.action;
    const note = action === 'dismiss' && typeof body.note === 'string' ? body.note : undefined;
    let result: { events: WireEvent[]; postedAnswer: boolean } | null = null;
    try {
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.answer.resolve',
        body: { sessionId: id, proposalId, action, ...(note !== undefined ? { note } : {}) },
        fn: async (client) => {
          result = await sessionRuns.resolveAnswerProposalInTx(client, id, user, proposalId, action, { note });
          return { ok: true as const };
        },
        onApplied: () => {
          if (!result) return;
          for (const event of result.events) publishEvent(event);
        },
      });
    } catch (err) {
      if (action === 'submit' && isQuestionNotPendingError(err)) {
        await sessionRuns.clearStalePendingQuestionForProposal(id, proposalId);
      }
      throw err;
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    if (opId) {
      let events: WireEvent[] = [];
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.cancel',
        body: { sessionId: id },
        fn: async (client) => {
          events = await sessionRuns.cancelSessionInTx(client, id, user.id);
          return { ok: true as const };
        },
        onApplied: () => {
          sessionRuns.afterCancelSession(id, events);
        },
      });
    } else {
      await sessionRuns.cancelSession(id, user.id);
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/stop-turn', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    if (opId) {
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.stop_turn',
        body: { sessionId: id },
        fn: async () => ({ ok: true as const }),
        onApplied: () => {
          sessionRuns.interruptTurn(id, user.id).catch(() => {});
        },
      });
    } else {
      await sessionRuns.interruptTurn(id, user.id);
    }
    return reply.code(202).send({ ok: true });
  });
}
