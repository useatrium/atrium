import type { FastifyInstance } from 'fastify';
import type { AppAuthContext } from '../app-auth.js';
import { recordClientErrorReport } from '../client-error-reports.js';
import type { Db } from '../db.js';

export function registerClientErrorRoutes(
  app: FastifyInstance,
  deps: { pool: Db; userFromRequest: AppAuthContext['userFromRequest'] },
): void {
  app.post('/api/client-errors', async (req, reply) => {
    const body = isRecord(req.body) ? req.body : {};
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

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}
