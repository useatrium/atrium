import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { UserRef } from './events.js';
import { verifySession } from './cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRef | null;
  }
}

export interface AppAuthDeps {
  pool: Db;
  secret: string;
  sessionCookie: string;
}

export interface AppAuthContext {
  userFromSession(raw: string | undefined | null): Promise<UserRef | null>;
  rawSession(req: FastifyRequest): string | undefined;
  userFromRequest(req: FastifyRequest): Promise<UserRef | null>;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

export function installAppAuth(app: FastifyInstance, deps: AppAuthDeps): AppAuthContext {
  const { pool, secret, sessionCookie } = deps;

  async function userFromSession(raw: string | undefined | null): Promise<UserRef | null> {
    const sessionId = verifySession(raw, secret);
    if (!sessionId) return null;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    const res = await pool.query<{
      id: string;
      handle: string;
      display_name: string;
      expires_at: Date;
    }>(
      `SELECT u.id, u.handle, u.display_name, s.expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) return null;
    // Sliding renewal: active sessions never expire, idle ones die in 30d.
    if (new Date(row.expires_at).getTime() - Date.now() < 15 * 24 * 60 * 60 * 1000) {
      void pool
        .query(`UPDATE auth_sessions SET expires_at = now() + interval '30 days' WHERE id = $1`, [sessionId])
        .catch(() => {});
    }
    return { id: row.id, handle: row.handle, displayName: row.display_name };
  }

  /** Signed session value from the request: bearer header (native) or cookie (web). */
  function rawSession(req: FastifyRequest): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    const queryToken = (req.query as { token?: unknown } | null | undefined)?.token;
    if (typeof queryToken === 'string') return queryToken;
    return req.cookies[sessionCookie];
  }

  async function userFromRequest(req: FastifyRequest): Promise<UserRef | null> {
    return userFromSession(rawSession(req));
  }

  function requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null {
    if (!req.user) {
      reply.code(401).send({ error: 'unauthorized', message: 'login required' });
      return null;
    }
    return req.user;
  }

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    req.user = await userFromRequest(req);
  });

  return { userFromSession, rawSession, userFromRequest, requireUser };
}
