import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import {
  isHarness,
  loadHarnessStateBundle,
  loadHarnessTranscript,
  storeHarnessStateBundle,
  storeHarnessTranscript,
} from '../harness-transcript.js';
import {
  deriveSessionCapabilitySnapshot,
  storeSessionCapabilitySnapshot,
} from '../session-capabilities.js';
import type { AgentProfiles } from '../agent-profiles.js';
import {
  listSessionProfileBundles,
  loadProfileBundleBlob,
  MAX_PROFILE_BUNDLE_BLOB_BYTES,
  normalizeBundleSha,
  storeProfileBundleBlob,
} from '../profile-bundles.js';
import { CLAUDE_CODE_PROVIDER, CODEX_PROVIDER, type ProviderCredentials } from '../provider-credentials.js';
import { getObjectBytes, headObject, uploadObject } from '../s3.js';

type InternalSessionRef = {
  id: string;
  channelId: string;
  workspaceId: string;
};

export interface InternalSessionRuntimeRouteDeps {
  pool: Db;
  maxUploadBytes: number;
  agentProfiles: AgentProfiles;
  providerCredentials: ProviderCredentials;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null>;
}

export async function registerInternalSessionRuntimeRoutes(
  app: FastifyInstance,
  deps: InternalSessionRuntimeRouteDeps,
): Promise<void> {
  const { pool, maxUploadBytes, agentProfiles, providerCredentials, requireCaptureKey, resolveInternalSessionRef } =
    deps;

  app.get('/api/internal/sessions/:id/harness-transcript', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const t = await loadHarnessTranscript(pool, { getObjectBytes }, session.id, harness);
    if (!t) return reply.code(404).send({ error: 'not_found', message: 'no transcript captured' });
    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('X-Transcript-Sha256', t.sha256);
    return reply.send(t.bytes);
  });

  await app.register(async (ht) => {
    ht.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );
    ht.put('/api/internal/sessions/:id/harness-transcript', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const harness = (req.query as { harness?: string }).harness ?? '';
      if (!isHarness(harness)) {
        return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'empty transcript body' });
      }
      const { size, sha256 } = await storeHarnessTranscript(pool, { uploadObject }, session.id, harness, bytes);
      try {
        const snapshot = deriveSessionCapabilitySnapshot({
          sessionId: session.id,
          harness,
          sourceSha256: sha256,
          bytes,
        });
        await storeSessionCapabilitySnapshot(pool, snapshot);
      } catch (err) {
        req.log.warn({ err, sessionId: session.id, harness }, 'failed to derive session capability snapshot');
      }
      return reply.send({ size_bytes: size, sha256 });
    });
  });

  app.get('/api/internal/sessions/:id/harness-state-bundle', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    const bundle = await loadHarnessStateBundle(pool, ref.id, harness);
    if (!bundle) return reply.code(404).send({ error: 'not_found', message: 'no harness-state bundle captured' });
    return reply.send(bundle);
  });

  app.put('/api/internal/sessions/:id/harness-state-bundle', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const { size, sha256 } = await storeHarnessStateBundle(
        pool,
        { uploadObject },
        ref.id,
        harness,
        (req.body ?? {}) as { adapterVersion?: string; manifest?: unknown },
      );
      return reply.send({ size_bytes: size, sha256 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid harness-state bundle';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.put('/api/internal/sessions/:id/profile-candidates', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const proposal = await agentProfiles.ingestSessionProposal(session.id, provider, req.body ?? {});
    return reply.send({ proposal });
  });

  app.put('/api/internal/sessions/:id/profile-baseline', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const { baselineHash } = await agentProfiles.putSessionBaseline(session.id, provider, req.body ?? {});
    return reply.send({ baselineHash });
  });

  app.get('/api/internal/sessions/:id/profile-bundles', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const bundles = await listSessionProfileBundles(pool, session.id, provider);
    return reply.send({ bundles });
  });

  app.get('/api/internal/sessions/:id/profile-bundle-blob', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const sha256 = normalizeBundleSha((req.query as { sha256?: string }).sha256);
    const bytes = await loadProfileBundleBlob(pool, { getObjectBytes }, sha256);
    if (!bytes) return reply.code(404).send({ error: 'not_found', message: 'profile bundle blob not found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Profile-Bundle-Sha256', sha256);
    return reply.send(bytes);
  });

  await app.register(async (profileBundleBlob) => {
    profileBundleBlob.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_PROFILE_BUNDLE_BLOB_BYTES },
      (_req, body, done) => done(null, body),
    );
    profileBundleBlob.put('/api/internal/sessions/:id/profile-bundle-blob', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const q = req.query as { sha256?: string; path?: string };
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await storeProfileBundleBlob(
        pool,
        { uploadObject, headObject },
        { sha256: q.sha256 ?? '', path: q.path ?? '', bytes },
      );
      return reply.send(result);
    });
  });

  app.put('/api/internal/sessions/:id/provider-credential-refresh', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    const session = await pool.query<{ spawned_by: string }>('SELECT spawned_by FROM sessions WHERE id = $1', [ref.id]);
    const ownerId = session.rows[0]?.spawned_by;
    if (!ownerId) return reply.code(404).send({ error: 'session_not_found' });

    const body = (req.body ?? {}) as { token?: unknown; authJson?: unknown };
    try {
      if (harness === 'codex') {
        const authJson =
          typeof body.authJson === 'string'
            ? body.authJson
            : body.authJson && typeof body.authJson === 'object'
              ? JSON.stringify(body.authJson)
              : '';
        if (!authJson.trim()) {
          return reply.code(400).send({ error: 'bad_request', message: 'Codex authJson required' });
        }
        const provider = await providerCredentials.upsertCodexAuthJson(ownerId, authJson);
        return reply.send({ provider });
      }
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) {
        return reply.code(400).send({ error: 'bad_request', message: 'Claude token required' });
      }
      const provider = await providerCredentials.upsertClaudeToken(ownerId, token);
      return reply.send({ provider });
    } catch (err) {
      const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
      const message = err instanceof Error ? err.message : 'invalid refreshed credential';
      await providerCredentials.markProviderAuthRequired(provider, ownerId, message);
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });
}
