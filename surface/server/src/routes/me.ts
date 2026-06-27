import { DEFAULT_PREFS, normalizePrefs, type UserPrefs } from '@atrium/surface-client/prefs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import type { UserRef } from '../events.js';
import type { WsHub } from '../hub.js';
import { AgentProfiles, providerFromProfileValue } from '../agent-profiles.js';
import { CODEX_PROVIDER, type ProviderCredentials } from '../provider-credentials.js';
import type { SessionRuns } from '../session-runs.js';

export interface MeRouteDeps {
  hub: WsHub;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
  optionalOpId(body: unknown): string | undefined;
  providerCredentials: ProviderCredentials;
  agentProfiles: AgentProfiles;
  sessionRuns: Pick<SessionRuns, 'clearClaudeAuthRequired' | 'clearProviderAuthRequired'>;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function withoutOpId(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.opId;
  return rest;
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

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const { hub, requireUser, optionalOpId, providerCredentials, agentProfiles, sessionRuns, runMutation } =
    deps;

  app.get('/api/me/provider-credentials', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { providers: await providerCredentials.list(user.id) };
  });

  app.put('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      return reply.code(400).send({ error: 'bad_request', message: 'Claude token required' });
    }
    const provider = await providerCredentials.upsertClaudeToken(user.id, token);
    await sessionRuns.clearClaudeAuthRequired(user.id);
    return { provider };
  });

  app.put('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { authJson?: unknown };
    const authJson = typeof body.authJson === 'string' ? body.authJson.trim() : '';
    if (!authJson) {
      return reply.code(400).send({ error: 'bad_request', message: 'Codex auth.json required' });
    }
    try {
      const provider = await providerCredentials.upsertCodexAuthJson(user.id, authJson);
      await sessionRuns.clearProviderAuthRequired(user.id, CODEX_PROVIDER);
      return { provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid Codex auth.json';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.delete('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteClaudeToken(user.id);
    return { ok: true };
  });

  app.delete('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteCodexAuthJson(user.id);
    return { ok: true };
  });

  app.get('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { profiles: await agentProfiles.listProfiles(user.id) };
  });

  app.post('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    return { profile: await agentProfiles.createProfile(user.id, provider, name) };
  });

  app.get('/api/me/agent-profiles/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { profile: await agentProfiles.getProfile(user.id, id) };
  });

  app.post('/api/me/agent-profiles/:id/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { version: await agentProfiles.createVersion(user.id, id, req.body ?? {}) };
  });

  app.post('/api/me/agent-profiles/import-local', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { provider?: unknown; proposal?: unknown };
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    return { proposal: await agentProfiles.createImportProposal(user.id, provider, body.proposal ?? req.body) };
  });

  app.patch('/api/me/prefs', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const prefsBody = req.body;
    const opId = optionalOpId(prefsBody);
    return runMutation({
      userId: user.id,
      opId,
      opType: 'prefs.patch',
      body: withoutOpId(prefsBody),
      fn: async (client) => {
        const current = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
          user.id,
        ]);
        const merged = normalizePrefs({
          ...normalizePrefs(current.rows[0]?.prefs),
          ...prefsPatch(prefsBody),
        });
        await client.query('UPDATE users SET prefs = $1 WHERE id = $2', [
          JSON.stringify(merged),
          user.id,
        ]);
        return { prefs: merged };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'prefs', prefs: response.prefs });
      },
    });
  });

  app.put('/api/me/drafts/:draftKey', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const { draftKey } = req.params as { draftKey: string };
    const body = req.body as { text?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'text is required' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'draft.set',
      body: { draftKey, text: body.text },
      fn: async (client) => {
        if (body.text === '') {
          await client.query(
            `UPDATE user_drafts
             SET text = '', deleted_at = now(), updated_at = now()
             WHERE user_id = $1 AND draft_key = $2`,
            [user.id, draftKey],
          );
          return { ok: true as const };
        }
        await client.query(
          `INSERT INTO user_drafts (user_id, draft_key, text, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, draft_key)
           DO UPDATE SET text = EXCLUDED.text, updated_at = now(), deleted_at = NULL`,
          [user.id, draftKey, body.text],
        );
        return { ok: true as const };
      },
    });
  });
}
