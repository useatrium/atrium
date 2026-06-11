import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { DEFAULT_PREFS, normalizePrefs, type UserPrefs } from '@atrium/surface-client/prefs';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import type { Db } from './db.js';
import { signSession, verifySession } from './cookie.js';
import {
  addChannelMember,
  DomainError,
  canAccessChannel,
  canAccessFile,
  createChannel,
  deleteMessage,
  editMessage,
  getOrCreateGdm,
  getOrCreateDm,
  leaveChannel,
  listChannelMembers,
  listChannelMessages,
  listChannelsFor,
  listThreadMessages,
  listUsers,
  listWorkspaces,
  postMessage,
  searchMessages,
  toggleReaction,
  type UserRef,
} from './events.js';
import { WsHub } from './hub.js';
import { FILE_URL_TTL_S, fileSignature, verifyFileSignature } from './filesign.js';
import { clearReceiptTimers, sendMessagePush } from './push.js';
import { ensureBucket, presignGet, presignPut } from './s3.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import type { AttachmentMeta } from './events.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRef | null;
  }
}

export interface AppDeps {
  pool: Db;
  hub?: WsHub;
  sessionSecret?: string;
  sessionRuns?: SessionRunsOptions;
  rateLimit?: false | { max?: number; loginMax?: number };
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const hub = deps.hub ?? new WsHub();
  const secret = deps.sessionSecret ?? config.sessionSecret;
  const sessionRuns = new SessionRuns(pool, hub, deps.sessionRuns);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  const rateLimit = deps.rateLimit;
  if (rateLimit !== false) {
    await app.register(fastifyRateLimit, {
      max: rateLimit?.max ?? 600,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req, context) => ({
        statusCode: context.statusCode,
        error: 'rate_limited',
        message: `rate limit exceeded, retry in ${context.after}`,
      }),
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const error = err as { statusCode?: number; message?: unknown };
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: 'rate_limited',
        message:
          typeof error.message === 'string' && error.message.length > 0
            ? error.message
            : 'rate limit exceeded',
      });
    }
    app.log.error(err);
    const status = error.statusCode ?? 500;
    return reply.code(status).send({ error: 'internal', message: 'internal error' });
  });

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
        .query(`UPDATE auth_sessions SET expires_at = now() + interval '30 days' WHERE id = $1`, [
          sessionId,
        ])
        .catch(() => {});
    }
    return { id: row.id, handle: row.handle, displayName: row.display_name };
  }

  /** Signed session value from the request: bearer header (native) or cookie (web). */
function rawSession(req: FastifyRequest): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    return req.cookies[config.sessionCookie];
  }

  function isAnswerBody(value: unknown): value is Record<string, { answers: string[] }> {
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

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function prefsPatch(input: Record<string, unknown>): Partial<UserPrefs> {
    const patch: Partial<UserPrefs> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!(key in DEFAULT_PREFS)) continue;
      const prefKey = key as keyof UserPrefs;
      if (Object.is(normalizePrefs({ [key]: value })[prefKey], value)) {
        (patch as Record<keyof UserPrefs, UserPrefs[keyof UserPrefs]>)[prefKey] =
          value as UserPrefs[keyof UserPrefs];
      }
    }
    return patch;
  }

  async function userFromRequest(req: FastifyRequest): Promise<UserRef | null> {
    return userFromSession(rawSession(req));
  }

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    req.user = await userFromRequest(req);
  });

  function requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null {
    if (!req.user) {
      reply.code(401).send({ error: 'unauthorized', message: 'login required' });
      return null;
    }
    return req.user;
  }

  function codeHash(email: string, code: string): string {
    return createHmac('sha256', secret).update(`${email}:${code}`).digest('base64url');
  }

  function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async function createAuthSession(
    reply: FastifyReply,
    user: { id: string; handle: string; display_name: string },
  ) {
    // Opportunistic reaping — keeps the table from accumulating dead rows.
    void pool.query('DELETE FROM auth_sessions WHERE expires_at < now()').catch(() => {});
    const session = await pool.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at)
       VALUES ($1, now() + interval '30 days') RETURNING id`,
      [user.id],
    );
    const token = signSession(session.rows[0]!.id, secret);
    reply.setCookie(config.sessionCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return {
      user: { id: user.id, handle: user.handle, displayName: user.display_name },
      token,
    };
  }

  function normalizeEmail(input: unknown): string {
    return String(input ?? '').trim().toLowerCase();
  }

  function displayNameFromEmail(email: string): string {
    return email.split('@')[0] || email;
  }

  function handleBaseFromEmail(email: string): string {
    const local = displayNameFromEmail(email).toLowerCase();
    let handle = local
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+/g, '-')
      .slice(0, 32);
    if (!/^[a-z0-9]/.test(handle)) handle = 'user';
    if (handle.length < 2) handle = `${handle}x`;
    return handle;
  }

  async function createUserForEmail(email: string) {
    const displayName = displayNameFromEmail(email);
    const base = handleBaseFromEmail(email).slice(0, 29);
    for (let i = 1; i <= 100; i += 1) {
      const suffix = i === 1 ? '' : `-${i}`;
      const handle = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      const inserted = await pool.query<{ id: string; handle: string; display_name: string }>(
        `INSERT INTO users (handle, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, handle, display_name`,
        [handle, displayName, email],
      );
      if (inserted.rows[0]) return inserted.rows[0]!;
      const existingEmail = await pool.query<{ id: string; handle: string; display_name: string }>(
        `SELECT id, handle, display_name FROM users WHERE email = $1`,
        [email],
      );
      if (existingEmail.rows[0]) return existingEmail.rows[0]!;
    }
    throw new Error('could not allocate handle');
  }

  async function userForEmail(email: string) {
    const existing = await pool.query<{ id: string; handle: string; display_name: string }>(
      `SELECT id, handle, display_name FROM users WHERE email = $1`,
      [email],
    );
    return existing.rows[0] ?? (await createUserForEmail(email));
  }

  function googleEnabled(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUrl);
  }

  function signOAuthState(): string {
    return signSession(`${Date.now()}:${randomUUID()}`, secret);
  }

  function verifyOAuthState(state: unknown): boolean {
    const payload = verifySession(typeof state === 'string' ? state : null, secret);
    if (!payload) return false;
    const [ts] = payload.split(':');
    const createdAt = Number(ts);
    return Number.isFinite(createdAt) && Date.now() - createdAt <= 10 * 60 * 1000;
  }

  async function userForGoogleIdentity(claims: {
    sub: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
  }) {
    const linked = await pool.query<{ id: string; handle: string; display_name: string }>(
      `SELECT u.id, u.handle, u.display_name
       FROM oauth_identities oi JOIN users u ON u.id = oi.user_id
       WHERE oi.provider = 'google' AND oi.subject = $1`,
      [claims.sub],
    );
    if (linked.rows[0]) return linked.rows[0]!;

    let user: { id: string; handle: string; display_name: string };
    if (claims.email && claims.emailVerified) {
      const existing = await pool.query<{ id: string; handle: string; display_name: string }>(
        `SELECT id, handle, display_name FROM users WHERE email = $1`,
        [claims.email],
      );
      user = existing.rows[0] ?? (await createUserForEmail(claims.email));
    } else {
      user = await createUserForEmail(`${claims.sub}@google.oauth.local`);
    }

    await pool.query(
      `INSERT INTO oauth_identities (provider, subject, user_id)
       VALUES ('google', $1, $2)
       ON CONFLICT (provider, subject) DO NOTHING`,
      [claims.sub, user.id],
    );
    return user;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  app.get('/auth/methods', async () => ({
    open: config.authOpen,
    email: true,
    google: googleEnabled(),
  }));

  app.post(
    '/auth/email/request',
    {
      config: { rateLimit: rateLimit === false ? false : { max: 6 } },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: string };
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email) || email.length > 320) {
        return reply
          .code(400)
          .send({ error: 'invalid_email', message: 'enter a valid email address' });
      }
      // Per-email cooldown: ignore rapid repeats (don't churn the pending code
      // or spam delivery) while keeping the response uniform so it can't be
      // used to probe which emails are active.
      const recent = await pool.query(
        `SELECT 1 FROM login_codes WHERE email = $1 AND created_at > now() - interval '30 seconds' LIMIT 1`,
        [email],
      );
      if (recent.rowCount) return { ok: true };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await pool.query('UPDATE login_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL', [
        email,
      ]);
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')`,
        [email, codeHash(email, code)],
      );
      // Only ever log the actual code when dev codes are explicitly enabled —
      // otherwise a prod deploy left in EMAIL_MODE=log would leak login factors.
      if (config.authDevCodes) {
        req.log.warn({ email, code }, 'auth email code (dev)');
      } else if (config.emailMode !== 'log') {
        req.log.warn({ email, mode: config.emailMode }, 'email transport mode is not implemented');
      }
      return config.authDevCodes ? { ok: true, devCode: code } : { ok: true };
    },
  );

  app.post('/auth/email/verify', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; code?: string };
    const email = normalizeEmail(body.email);
    const code = String(body.code ?? '').trim();
    if (!EMAIL_RE.test(email) || email.length > 320 || !CODE_RE.test(code)) {
      return reply.code(400).send({ error: 'invalid_code', message: 'invalid email code' });
    }
    // Atomic single-use redemption: consume the latest valid code ONLY if the
    // hash matches, in one UPDATE. Concurrent verifies can't double-redeem or
    // race past the lockout (the row lock serializes them, and a second
    // correct guess sees consumed_at already set → rowCount 0).
    const consumed = await pool.query<{ id: string }>(
      `UPDATE login_codes SET consumed_at = now()
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )
       AND code_hash = $2
       RETURNING id`,
      [email, codeHash(email, code)],
    );
    if (consumed.rowCount === 1) {
      const user = await userForEmail(email);
      return createAuthSession(reply, user);
    }
    // Wrong (or no valid) code: atomically burn an attempt on the latest valid
    // code, locking it after the 5th failure.
    await pool.query(
      `UPDATE login_codes
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE consumed_at END
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )`,
      [email],
    );
    return reply.code(400).send({ error: 'invalid_code', message: 'invalid email code' });
  });

  const OAUTH_STATE_COOKIE = 'atrium_oauth_state';

  app.get('/auth/oauth/google', async (_req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: 'not_found' });
    const state = signOAuthState();
    // Bind the state to THIS browser: the callback requires the same value
    // back in an httpOnly cookie, so a valid signed state can't be replayed
    // into a victim's session (login CSRF).
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth/oauth',
      maxAge: 600,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.googleClientId);
    url.searchParams.set('redirect_uri', config.googleRedirectUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/auth/oauth/google/callback', async (req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: 'not_found' });
    const query = req.query as { code?: string; state?: string };
    const cookieState = req.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/oauth' });
    if (
      !query.code ||
      !verifyOAuthState(query.state) ||
      !cookieState ||
      query.state !== cookieState
    ) {
      return reply.code(400).send({ error: 'invalid_oauth_state' });
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUrl,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return reply.code(400).send({ error: 'oauth_exchange_failed' });
    const tokenBody = (await tokenRes.json()) as { id_token?: string };
    if (!tokenBody.id_token) return reply.code(400).send({ error: 'invalid_id_token' });
    // Verify the id_token's SIGNATURE via Google's tokeninfo endpoint (server-
    // side validation, no JWKS to hand-roll). The returned claims are trusted.
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenBody.id_token)}`,
    );
    if (!infoRes.ok) return reply.code(400).send({ error: 'invalid_id_token' });
    const claims = (await infoRes.json()) as Record<string, unknown>;
    const exp = Number(claims.exp);
    if (
      typeof claims.sub !== 'string' ||
      claims.aud !== config.googleClientId ||
      typeof claims.iss !== 'string' ||
      !GOOGLE_ISSUERS.has(claims.iss) ||
      !Number.isFinite(exp) ||
      exp * 1000 <= Date.now()
    ) {
      return reply.code(400).send({ error: 'invalid_id_token' });
    }
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : undefined;
    const user = await userForGoogleIdentity({
      sub: claims.sub,
      email,
      // tokeninfo returns claim values as strings ("true"); the token-exchange
      // path returned a boolean — accept both.
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: typeof claims.name === 'string' ? claims.name : undefined,
    });
    await createAuthSession(reply, user);
    return reply.redirect('/', 302);
  });

  app.post(
    '/auth/login',
    {
      config: { rateLimit: rateLimit === false ? false : { max: rateLimit?.loginMax ?? 30 } },
    },
    async (req, reply) => {
      if (!config.authOpen) {
        return reply.code(403).send({ error: 'auth_closed' });
      }
      const body = (req.body ?? {}) as { handle?: string; displayName?: string };
      const handle = String(body.handle ?? '').trim().toLowerCase();
      const displayName = String(body.displayName ?? '').trim();
      if (!HANDLE_RE.test(handle)) {
        return reply.code(400).send({
          error: 'invalid_handle',
          message: 'handle must be 2-32 chars: letters, digits, - or _',
        });
      }
      if (displayName.length > 64) {
        return reply
          .code(400)
          .send({ error: 'invalid_display_name', message: 'display name too long' });
      }
      // A blank display name means "keep what I had" for returning users —
      // re-logins must not silently rewrite attribution across history.
      const user = await pool.query<{ id: string; handle: string; display_name: string }>(
        `INSERT INTO users (handle, display_name) VALUES ($1, COALESCE(NULLIF($2, ''), $1))
         ON CONFLICT (handle) DO UPDATE SET display_name = COALESCE(NULLIF($2, ''), users.display_name)
         RETURNING id, handle, display_name`,
        [handle, displayName],
      );
      const u = user.rows[0]!;
      // Native clients can't rely on cookies — they store the token and send it
      // as `Authorization: Bearer` (HTTP) or `?token=` (WS upgrade).
      return createAuthSession(reply, u);
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res = await pool.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
      user.id,
    ]);
    return { user, prefs: normalizePrefs(res.rows[0]?.prefs) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const sessionId = verifySession(rawSession(req), secret);
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
      await pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
    }
    reply.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Workspaces & channels
  // -------------------------------------------------------------------------

  app.get('/api/workspaces', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { workspaces: await listWorkspaces(pool) };
  });

  app.get('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { channels: await listChannelsFor(pool, user.id) };
  });

  app.post('/api/channels/:id/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { lastReadEventId?: number };
    const lastReadEventId = Number(body.lastReadEventId);
    if (!Number.isSafeInteger(lastReadEventId) || lastReadEventId < 0) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'lastReadEventId must be a non-negative integer' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      // 404, not 403 — don't leak the existence of someone else's DM.
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const res = await pool.query<{ last_read_event_id: string; advanced: boolean }>(
      `WITH previous AS (
         SELECT last_read_event_id
         FROM channel_read_cursors
         WHERE user_id = $1 AND channel_id = $2
       ), upsert AS (
         INSERT INTO channel_read_cursors (user_id, channel_id, last_read_event_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE
         SET last_read_event_id = GREATEST(
               channel_read_cursors.last_read_event_id,
               EXCLUDED.last_read_event_id
             ),
             updated_at = CASE
               WHEN EXCLUDED.last_read_event_id > channel_read_cursors.last_read_event_id
               THEN now()
               ELSE channel_read_cursors.updated_at
             END
         RETURNING last_read_event_id
       )
       SELECT upsert.last_read_event_id,
              COALESCE((SELECT last_read_event_id FROM previous), 0) < upsert.last_read_event_id
                AS advanced
       FROM upsert`,
      [user.id, id, lastReadEventId],
    );
    const stored = Number(res.rows[0]!.last_read_event_id);
    if (res.rows[0]!.advanced) {
      hub.sendToUsers([user.id], { type: 'read', channelId: id, lastReadEventId: stored });
    }
    return { lastReadEventId: stored };
  });

  app.post('/api/channels/:id/mute', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { muted?: unknown };
    if (typeof body.muted !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'muted must be boolean' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    if (body.muted) {
      await pool.query(
        `INSERT INTO channel_mutes (user_id, channel_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, channel_id) DO NOTHING`,
        [user.id, id],
      );
    } else {
      await pool.query('DELETE FROM channel_mutes WHERE user_id = $1 AND channel_id = $2', [
        user.id,
        id,
      ]);
    }
    hub.sendToUsers([user.id], { type: 'muted', channelId: id, muted: body.muted });
    return { muted: body.muted };
  });

  app.patch('/api/me/prefs', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const current = await pool.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
      user.id,
    ]);
    const merged = normalizePrefs({
      ...normalizePrefs(current.rows[0]?.prefs),
      ...prefsPatch(req.body),
    });
    await pool.query('UPDATE users SET prefs = $1 WHERE id = $2', [JSON.stringify(merged), user.id]);
    hub.sendToUsers([user.id], { type: 'prefs', prefs: merged });
    return { prefs: merged };
  });

  app.get('/api/users', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { users: await listUsers(pool) };
  });

  app.post('/api/dms', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { userId?: string; userIds?: unknown };
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter((id): id is string => typeof id === 'string')
      : body.userId && typeof body.userId === 'string'
        ? [body.userId]
        : [];
    const distinctUserIds = [...new Set(userIds)];
    if (distinctUserIds.length < 1 || distinctUserIds.length > 8) {
      return reply.code(400).send({ error: 'bad_request', message: 'userIds must contain 1-8 users' });
    }
    const existingUsers = await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      distinctUserIds,
    ]);
    if (existingUsers.rows.length !== distinctUserIds.length) {
      return reply.code(404).send({ error: 'user_not_found', message: 'user not found' });
    }
    const workspaces = await listWorkspaces(pool);
    const ws = workspaces[0];
    if (!ws) return reply.code(500).send({ error: 'no_workspace', message: 'no workspace' });
    const isOneToOne = new Set([user.id, ...distinctUserIds]).size <= 2;
    const { channel, created } = isOneToOne
      ? await getOrCreateDm(pool, {
          workspaceId: ws.id,
          userIdA: user.id,
          userIdB: distinctUserIds[0]!,
        })
      : await getOrCreateGdm(pool, {
          workspaceId: ws.id,
          creatorId: user.id,
          userIds: distinctUserIds,
        });
    if (created) {
      // Only members learn the DM/GDM exists.
      hub.publishToUsers(
        channel.members?.map((m) => m.id) ?? [user.id, ...distinctUserIds],
        {
          id: 0,
          workspaceId: ws.id,
          channelId: channel.id,
          threadRootEventId: null,
          type: 'channel.created',
          actorId: user.id,
          payload: { name: channel.name, channel },
          createdAt: new Date().toISOString(),
          author: user,
        },
      );
    }
    return reply.code(created ? 201 : 200).send({ channel });
  });

  app.post('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: string; private?: unknown };
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(name)) {
      return reply.code(400).send({
        error: 'invalid_channel_name',
        message: 'channel name must be 1-32 chars: lowercase letters, digits, - or _',
      });
    }
    const workspaces = await listWorkspaces(pool);
    const ws = workspaces[0];
    if (!ws) return reply.code(500).send({ error: 'no_workspace', message: 'no workspace bootstrapped' });
    const { channel, event } = await createChannel(pool, {
      workspaceId: ws.id,
      name,
      actorId: user.id,
      private: body.private === true,
    });
    const createdEvent = { ...event, payload: { ...event.payload, channel } };
    if (channel.kind === 'public') {
      // channel.created is broadcast to everyone so sidebars stay live.
      hub.publishGlobal(createdEvent);
    } else {
      hub.publishToUsers([user.id], createdEvent);
    }
    return reply.code(201).send({ channel });
  });

  app.get('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const result = await listChannelMembers(pool, { channelId: id, userId: user.id });
    if (!result) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { members: result.members };
  });

  app.post('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userId?: unknown };
    if (typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    const result = await addChannelMember(pool, {
      channelId: id,
      actorId: user.id,
      userId: body.userId,
    });
    if (!result) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    hub.publishToUsers([body.userId], {
      id: 0,
      workspaceId: result.channel.workspaceId,
      channelId: result.channel.id,
      threadRootEventId: null,
      type: 'channel.created',
      actorId: user.id,
      payload: { name: result.channel.name, channel: result.channel },
      createdAt: new Date().toISOString(),
      author: user,
    });
    hub.publishEvent(result.event);
    return reply.code(201).send({ member: result.member });
  });

  app.delete('/api/channels/:id/members/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const result = await leaveChannel(pool, { channelId: id, userId: user.id });
    if (!result) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    hub.publishEvent(result.event);
    hub.sendToUsers([user.id], { type: 'channel-left', channelId: id });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  app.get('/api/channels/:id/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await canAccessChannel(pool, user.id, id))) {
      // 404, not 403 — don't leak the existence of someone else's DM.
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const q = req.query as { before_id?: string; after_id?: string; limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const beforeId = q.before_id ? Number(q.before_id) : undefined;
    const afterId = q.after_id ? Number(q.after_id) : undefined;
    if ([limit, beforeId, afterId].some((v) => v !== undefined && !Number.isFinite(v))) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric query params expected' });
    }
    if (beforeId !== undefined && afterId !== undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'use before_id or after_id, not both' });
    }
    return listChannelMessages(pool, { channelId: id, beforeId, afterId, limit });
  });

  app.get('/api/search', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = (req.query as { q?: string; limit?: string });
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

  app.get('/api/threads/:rootEventId/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const rootEventId = Number((req.params as { rootEventId: string }).rootEventId);
    if (!Number.isFinite(rootEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric root event id expected' });
    }
    const root = await pool.query<{ channel_id: string | null }>(
      'SELECT channel_id FROM events WHERE id = $1',
      [rootEventId],
    );
    const channelId = root.rows[0]?.channel_id;
    if (!channelId || !(await canAccessChannel(pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'thread_not_found', message: 'thread not found' });
    }
    return listThreadMessages(pool, { rootEventId });
  });

  app.post('/api/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      text?: string;
      clientMsgId?: string;
      threadRootEventId?: number;
      attachments?: unknown;
    };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    const attachmentIds = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is string => typeof a === 'string').slice(0, 10)
      : [];
    if (text.trim().length === 0 && attachmentIds.length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    let attachments: AttachmentMeta[] | undefined;
    if (attachmentIds.length > 0) {
      const rows = await pool.query<{
        id: string;
        filename: string;
        content_type: string;
        size_bytes: string;
        width: number | null;
        height: number | null;
      }>(
        `SELECT id, filename, content_type, size_bytes, width, height
         FROM files WHERE id = ANY($1::uuid[]) AND uploader_id = $2`,
        [attachmentIds, user.id],
      );
      if (rows.rows.length !== attachmentIds.length) {
        return reply
          .code(400)
          .send({ error: 'bad_attachment', message: 'unknown or foreign attachment id' });
      }
      attachments = attachmentIds.map((id) => {
        const f = rows.rows.find((r) => r.id === id)!;
        return {
          id: f.id,
          filename: f.filename,
          contentType: f.content_type,
          size: Number(f.size_bytes),
          ...(f.width != null ? { width: f.width } : {}),
          ...(f.height != null ? { height: f.height } : {}),
        };
      });
    }
    const clientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.length <= 64
        ? body.clientMsgId
        : null;
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    const channel = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [body.channelId],
    );
    if (!channel.rows[0] || !(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const event = await postMessage(pool, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: body.channelId,
      actorId: user.id,
      text,
      clientMsgId,
      threadRootEventId,
      attachments,
    });
    hub.publishEvent(event);
    void sendMessagePush(pool, hub, event).catch((err) =>
      app.log.warn({ err }, 'push fanout failed'),
    );
    return reply.code(201).send({ event });
  });

  app.patch('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    const event = await editMessage(pool, { targetEventId, actorId: user.id, text });
    hub.publishEvent(event);
    return { event };
  });

  app.delete('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const event = await deleteMessage(pool, { targetEventId, actorId: user.id });
    hub.publishEvent(event);
    return { event };
  });

  // -------------------------------------------------------------------------
  // File uploads (presigned to S3/MinIO)
  // -------------------------------------------------------------------------

  app.post('/api/uploads', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      filename?: string;
      contentType?: string;
      size?: number;
      width?: number;
      height?: number;
    };
    const filename = String(body.filename ?? '').trim().slice(0, 200) || 'file';
    const contentType =
      typeof body.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.contentType)
        ? body.contentType
        : 'application/octet-stream';
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'size required' });
    }
    if (size > config.maxUploadBytes) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `file exceeds ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`,
      });
    }
    const dim = (v: unknown) =>
      Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null;
    const workspaces = await listWorkspaces(pool);
    const ws = workspaces[0];
    if (!ws) return reply.code(500).send({ error: 'no_workspace', message: 'no workspace' });
    try {
      await ensureBucket();
    } catch {
      return reply
        .code(503)
        .send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO files (workspace_id, uploader_id, filename, content_type, size_bytes, width, height, s3_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '') RETURNING id`,
      [ws.id, user.id, filename, contentType, size, dim(body.width), dim(body.height)],
    );
    const fileId = inserted.rows[0]!.id;
    const s3Key = `${fileId}/${filename}`;
    await pool.query('UPDATE files SET s3_key = $1 WHERE id = $2', [s3Key, fileId]);
    const uploadUrl = await presignPut(s3Key, contentType);
    return reply.code(201).send({ fileId, uploadUrl });
  });

  // Mint a short-lived signed URL for opening a file outside an authenticated
  // context (external browser, share sheet). File-scoped — never the session.
  app.get('/api/files/:id/url', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    if (!(await canAccessFile(pool, user.id, id))) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const expires = Math.floor(Date.now() / 1000) + FILE_URL_TTL_S;
    const sig = fileSignature(id, expires, secret);
    return {
      url: `/api/files/${id}?expires=${expires}&sig=${encodeURIComponent(sig)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    // Either a valid short-lived file signature (the capability was minted by
    // someone with access via /api/files/:id/url) or a logged-in caller who
    // can access a channel the file is attached to. The signed path is the
    // mobile/in-app image hot path's sibling; the authed path gates on
    // canAccessFile so a non-member can't pull a file by its id.
    const q = (req.query ?? {}) as { expires?: unknown; sig?: unknown };
    const signed =
      typeof q.sig === 'string' &&
      typeof q.expires === 'string' &&
      verifyFileSignature(id, Number(q.expires), q.sig, secret);
    if (!signed) {
      const user = requireUser(req, reply);
      if (!user) return;
      if (!(await canAccessFile(pool, user.id, id))) {
        return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
      }
    }
    const res = await pool.query<{
      filename: string;
      content_type: string;
      s3_key: string;
    }>('SELECT filename, content_type, s3_key FROM files WHERE id = $1', [id]);
    const file = res.rows[0];
    if (!file || !file.s3_key) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const inline =
      file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
    const url = await presignGet(file.s3_key, file.filename, inline);
    return reply.redirect(url, 302);
  });

  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { emoji?: string };
    if (typeof body.emoji !== 'string' || !body.emoji) {
      return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
    }
    const event = await toggleReaction(pool, {
      targetEventId,
      actorId: user.id,
      emoji: body.emoji,
    });
    hub.publishEvent(event);
    return { event };
  });

  // -------------------------------------------------------------------------
  // Agent sessions
  // -------------------------------------------------------------------------

  app.post('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      threadRootEventId?: number;
      task?: string;
      harness?: string;
    };
    const task = typeof body.task === 'string' ? body.task : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (task.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_task', message: 'task is empty' });
    }
    if (Buffer.byteLength(task, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'task_too_large', message: 'task exceeds 8KB' });
    }
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    if (!(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const bodySpawnId = (body as { clientSpawnId?: unknown }).clientSpawnId;
    const session = await sessionRuns.createSession({
      channelId: body.channelId,
      threadRootEventId,
      task,
      harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
      clientSpawnId:
        typeof bodySpawnId === 'string' && bodySpawnId.length <= 80 ? bodySpawnId : undefined,
      user,
    });
    return reply.code(201).send({ session });
  });

  app.get('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { status?: string; limit?: string };
    const status =
      q.status === 'running' || q.status === 'recent' || q.status === 'all'
        ? q.status
        : q.status == null
          ? 'all'
          : null;
    if (!status) {
      return reply.code(400).send({ error: 'bad_query', message: 'invalid status filter' });
    }
    const rawLimit = q.limit == null ? 50 : Number(q.limit);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'limit must be positive' });
    }
    const limit = Math.min(200, Math.floor(rawLimit));
    return { sessions: await sessionRuns.listSessionsForUser({ userId: user.id, status, limit }) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { session: await sessionRuns.getSessionForUser(id, user.id) };
  });

  app.get('/api/sessions/:id/stream', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { after_event_id?: string };
    const afterEventId = q.after_event_id ? Number(q.after_event_id) : 0;
    if (!Number.isFinite(afterEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'after_event_id must be numeric' });
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

  // Every session sub-resource is channel-access gated (404, like
  // getSessionForUser) so a guessed session id in a private/DM channel can't
  // be steered, seat-hijacked, or cancelled by a non-member.
  async function requireSessionAccess(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<UserRef | null> {
    const user = requireUser(req, reply);
    if (!user) return null;
    const { id } = req.params as { id: string };
    if (!(await sessionRuns.userCanAccessSession(id, user.id))) {
      reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
      return null;
    }
    return user;
  }

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    await sessionRuns.postUserMessage(id, user.id, text);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/answer', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { questionId?: unknown; answers?: unknown };
    if (typeof body.questionId !== 'string' || !isAnswerBody(body.answers)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'questionId and answers are required' });
    }
    await sessionRuns.answerQuestion(id, user, body.questionId, body.answers);
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

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.cancelSession(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Push notifications (Expo)
  // -------------------------------------------------------------------------

  app.post('/api/push/register', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown; platform?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const platform = body.platform === 'android' ? 'android' : 'ios';
    if (!token || token.length > 200) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    // A device token follows whoever logged in last on that device.
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
      [token, user.id, platform],
    );
    return { ok: true };
  });

  app.post('/api/push/unregister', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    await pool.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [
      body.token,
      user.id,
    ]);
    return { ok: true };
  });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true, config: { rateLimit: false } }, (socket, req) => {
      // Handlers must attach synchronously: clients send subscribe/focus the
      // moment the socket opens, and frames that arrive while auth is still
      // awaiting the DB would otherwise be dropped on the floor (the client
      // would then sit on a "live" socket subscribed to nothing). Buffer
      // frames until auth resolves, then replay.
      let client: ReturnType<WsHub['addClient']> | null = null;
      const preAuth: Buffer[] = [];

      const handleMessage = (user: UserRef, raw: Buffer) => {
        if (!client) return;
        const c = client;
        let msg: { type?: string; channelIds?: unknown; channelId?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'subscribe' && Array.isArray(msg.channelIds)) {
          const ids = msg.channelIds
            .filter((v): v is string => typeof v === 'string')
            .slice(0, 500);
          // Member-only channels (and session: presence keys) drop ids the
          // user can't access so fanout/presence can trust subscriptions. A
          // session: key is gated on the session's channel — otherwise a
          // non-member could appear as a watcher of a foreign private session.
          void (async () => {
            const allowed: string[] = [];
            for (const id of ids) {
              const ok = id.startsWith('session:')
                ? await sessionRuns.userCanAccessSession(id.slice('session:'.length), user.id)
                : await canAccessChannel(pool, user.id, id);
              if (ok) allowed.push(id);
            }
            hub.subscribe(c, allowed);
          })().catch(() => {});
        } else if (msg.type === 'focus') {
          const channelId = typeof msg.channelId === 'string' ? msg.channelId : null;
          if (!channelId) {
            hub.setFocus(c, null);
          } else {
            void canAccessChannel(pool, user.id, channelId)
              .then((ok) => {
                if (ok) hub.setFocus(c, channelId);
              })
              .catch(() => {});
          }
        } else if (msg.type === 'typing') {
          // Focus is already access-checked; require it so nobody can signal
          // into a DM they aren't reading.
          if (typeof msg.channelId === 'string' && c.focusedChannelId === msg.channelId) {
            hub.relayTyping(c, msg.channelId);
          }
        } else if (msg.type === 'ping') {
          hub.sendTo(c, { type: 'pong', t: Date.now() });
        }
      };

      let authedUser: UserRef | null = null;
      socket.on('message', (raw: Buffer) => {
        if (authedUser) handleMessage(authedUser, raw);
        else preAuth.push(raw);
      });
      socket.on('pong', () => {
        if (client) client.isAlive = true;
      });
      const cleanup = () => {
        if (client) hub.removeClient(client);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      void (async () => {
        // Browsers authenticate the upgrade with the session cookie; native
        // clients can't set headers on WebSocket, so accept ?token= too.
        const q = (req.query ?? {}) as { token?: unknown };
        const user =
          (typeof q.token === 'string' ? await userFromSession(q.token) : null) ??
          (await userFromRequest(req as FastifyRequest));
        if (!user) {
          socket.close(4401, 'unauthorized');
          return;
        }
        if (socket.readyState !== socket.OPEN) return; // closed while authing
        client = hub.addClient(socket, user);
        authedUser = user;
        for (const raw of preAuth.splice(0)) handleMessage(user, raw);
      })().catch(() => socket.close(1011, 'auth error'));
    });
  });

  app.addHook('onReady', async () => {
    await sessionRuns.resumeActiveSessions();
  });
  app.addHook('onClose', async () => {
    clearReceiptTimers();
    await sessionRuns.close();
  });

  return app;
}
