import type { FastifyInstance } from 'fastify';
import { Schema } from 'effect';
import type { AppAuthContext } from '../app-auth.js';
import { recordClientErrorReport } from '../client-error-reports.js';
import type { Db } from '../db.js';
import { decodeRouteBody } from '../route-schema.js';

const ClientErrorBodySchema = Schema.Struct({
  kind: Schema.optional(Schema.Unknown),
  errorName: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
  stack: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.Unknown),
  component: Schema.optional(Schema.Unknown),
});

type ClientErrorBody = Schema.Schema.Type<typeof ClientErrorBodySchema>;

export function registerClientErrorRoutes(
  app: FastifyInstance,
  deps: { pool: Db; userFromRequest: AppAuthContext['userFromRequest'] },
): void {
  app.post('/api/client-errors', async (req, reply) => {
    const body: ClientErrorBody = isRecord(req.body) ? decodeRouteBody(ClientErrorBodySchema, req.body) : {};
    const user = await deps.userFromRequest(req).catch(() => null);
    const report = await recordClientErrorReport(deps.pool, {
      userId: user?.id ?? null,
      kind: stringField(body, 'kind') ?? 'unknown',
      errorName: stringField(body, 'errorName'),
      message: stringField(body, 'message'),
      stack: stringField(body, 'stack'),
      urlPath: stringField(body, 'url'),
      component: stringField(body, 'component'),
      userAgent: req.headers['user-agent'],
    });
    return reply.code(202).send({ ok: true, id: report.id });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: ClientErrorBody, key: keyof ClientErrorBody): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}
