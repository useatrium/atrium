import type { FastifyReply } from 'fastify';

interface ChangeCursor {
  xid: string;
  id: string;
}

export function parseChangePage(
  reply: FastifyReply,
  query: { since?: string; limit?: string },
  initialCursor: ChangeCursor,
): { cursor: ChangeCursor; limit: number } | null {
  let cursor = initialCursor;
  if (typeof query.since === 'string' && query.since.length > 0) {
    const match = /^(\d+)\.(\d+)$/.exec(query.since);
    if (!match) {
      reply.code(400).send({ error: 'bad_query', message: 'since must be "<xid>.<id>"' });
      return null;
    }
    cursor = { xid: match[1]!, id: match[2]! };
  }

  let limit = 500;
  if (typeof query.limit === 'string') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
      reply.code(400).send({ error: 'bad_query', message: 'limit must be 1..5000' });
      return null;
    }
    limit = parsed;
  }
  return { cursor, limit };
}
