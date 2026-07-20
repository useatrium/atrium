import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizePrefs } from '@atrium/surface-client/prefs';
import { config } from '../config.js';
import { signSession, verifySession } from '../cookie.js';
import type { Db } from '../db.js';
import { ensureDefaultWorkspace, type UserRef } from '../events.js';
import { addWorkspaceMember } from '../membership.js';
import { emailDeliveryConfigured, sendLoginCode } from '../email.js';
import { userRefFromRow } from '../user-ref.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const OAUTH_STATE_COOKIE = 'atrium_oauth_state';

interface AuthUserRow {
  id: string;
  handle: string;
  display_name: string;
  avatar_s3_key?: string | null;
  avatar_version?: number | null;
}

export interface AuthRouteDeps {
  pool: Db;
  secret: string;
  callsConfigured: boolean;
  rateLimit: false | { max?: number; loginMax?: number } | undefined;
  emailFetch?: typeof fetch;
  rawSession(req: FastifyRequest): string | undefined;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function normalizeEmail(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toLowerCase();
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

function googleEnabled(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUrl);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { pool, secret, callsConfigured, rateLimit, emailFetch, rawSession, requireUser } = deps;

  function codeHash(email: string, code: string): string {
    return createHmac('sha256', secret).update(`${email}:${code}`).digest('base64url');
  }

  async function joinDefaultWorkspace(userId: string): Promise<void> {
    const workspace = await ensureDefaultWorkspace(pool);
    await addWorkspaceMember(pool, workspace.id, userId);
  }

  async function createAuthSession(reply: FastifyReply, user: AuthUserRow) {
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
      user: userRefFromRow(user),
      token,
    };
  }

  async function createUserForEmail(email: string): Promise<AuthUserRow> {
    const displayName = displayNameFromEmail(email);
    const base = handleBaseFromEmail(email).slice(0, 29);
    for (let i = 1; i <= 100; i += 1) {
      const suffix = i === 1 ? '' : `-${i}`;
      const handle = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      const inserted = await pool.query<AuthUserRow>(
        `INSERT INTO users (handle, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, handle, display_name, avatar_s3_key, avatar_version`,
        [handle, displayName, email],
      );
      if (inserted.rows[0]) {
        await joinDefaultWorkspace(inserted.rows[0].id);
        return inserted.rows[0];
      }
      const existingEmail = await pool.query<AuthUserRow>(
        `SELECT id, handle, display_name, avatar_s3_key, avatar_version FROM users WHERE email = $1`,
        [email],
      );
      if (existingEmail.rows[0]) return existingEmail.rows[0];
    }
    throw new Error('could not allocate handle');
  }

  async function userForEmail(email: string): Promise<AuthUserRow> {
    const existing = await pool.query<AuthUserRow>(
      `SELECT id, handle, display_name, avatar_s3_key, avatar_version FROM users WHERE email = $1`,
      [email],
    );
    return existing.rows[0] ?? (await createUserForEmail(email));
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
  }): Promise<AuthUserRow> {
    const linked = await pool.query<AuthUserRow>(
      `SELECT u.id, u.handle, u.display_name, u.avatar_s3_key, u.avatar_version
       FROM oauth_identities oi JOIN users u ON u.id = oi.user_id
       WHERE oi.provider = 'google' AND oi.subject = $1`,
      [claims.sub],
    );
    if (linked.rows[0]) return linked.rows[0];

    let user: AuthUserRow;
    if (claims.email && claims.emailVerified) {
      const existing = await pool.query<AuthUserRow>(
        `SELECT id, handle, display_name, avatar_s3_key, avatar_version FROM users WHERE email = $1`,
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

  app.get('/auth/methods', async () => {
    const emailUsable =
      config.authDevCodes ||
      (config.emailMode === 'resend' &&
        emailDeliveryConfigured({
          mode: config.emailMode,
          from: config.emailFrom,
          resendApiKey: config.resendApiKey,
        }));

    return {
      open: config.authOpen,
      email: emailUsable,
      google: googleEnabled(),
      calls: callsConfigured,
    };
  });

  app.post(
    '/auth/email/request',
    {
      config: { rateLimit: rateLimit === false ? false : { max: 6 } },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: string };
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email) || email.length > 320) {
        return reply.code(400).send({ error: 'invalid_email', message: 'enter a valid email address' });
      }
      const recent = await pool.query(
        `SELECT 1 FROM login_codes WHERE email = $1 AND created_at > now() - interval '30 seconds' LIMIT 1`,
        [email],
      );
      if (recent.rowCount) return { ok: true };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await pool.query('UPDATE login_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL', [email]);
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')`,
        [email, codeHash(email, code)],
      );
      try {
        await sendLoginCode(email, code, {
          config: {
            mode: config.emailMode,
            from: config.emailFrom,
            resendApiKey: config.resendApiKey,
          },
          fetchImpl: emailFetch,
          logCode: config.authDevCodes
            ? (to, c) => req.log.warn({ email: to, code: c }, 'auth email code (dev)')
            : undefined,
        });
      } catch (err) {
        req.log.error({ err, email }, 'login code delivery failed');
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
    const consumed = await pool.query<{ id: string }>(
      `UPDATE login_codes SET consumed_at = now()
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )
       AND code_hash = $2
       AND consumed_at IS NULL
       AND expires_at > now()
       AND attempts < 5
       RETURNING id`,
      [email, codeHash(email, code)],
    );
    if (consumed.rowCount === 1) {
      const user = await userForEmail(email);
      return createAuthSession(reply, user);
    }
    await pool.query(
      `UPDATE login_codes
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE consumed_at END
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )
       AND consumed_at IS NULL
       AND expires_at > now()
       AND attempts < 5`,
      [email],
    );
    return reply.code(400).send({ error: 'invalid_code', message: 'invalid email code' });
  });

  app.get('/auth/oauth/google', async (_req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: 'not_found' });
    const state = signOAuthState();
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
    if (!query.code || !verifyOAuthState(query.state) || !cookieState || query.state !== cookieState) {
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
      const handle = String(body.handle ?? '')
        .trim()
        .toLowerCase();
      const displayName = String(body.displayName ?? '').trim();
      if (!HANDLE_RE.test(handle)) {
        return reply.code(400).send({
          error: 'invalid_handle',
          message: 'handle must be 2-32 chars: letters, digits, - or _',
        });
      }
      if (displayName.length > 64) {
        return reply.code(400).send({ error: 'invalid_display_name', message: 'display name too long' });
      }
      let user = await pool.query<AuthUserRow>(
        `INSERT INTO users (handle, display_name) VALUES ($1, COALESCE(NULLIF($2, ''), $1))
         ON CONFLICT DO NOTHING
         RETURNING id, handle, display_name, avatar_s3_key, avatar_version`,
        [handle, displayName],
      );
      if (user.rows[0]) {
        await joinDefaultWorkspace(user.rows[0].id);
      } else {
        user = await pool.query<AuthUserRow>(
          `UPDATE users
           SET display_name = COALESCE(NULLIF($2, ''), display_name)
           WHERE handle = $1
           RETURNING id, handle, display_name, avatar_s3_key, avatar_version`,
          [handle, displayName],
        );
      }
      return createAuthSession(reply, user.rows[0]!);
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res = await pool.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [user.id]);
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
}
