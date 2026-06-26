import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: async () => null,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

const KEY = 'agent-profile-test-key';
const SHA = 'a'.repeat(64);
const CODEX_AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'codex-access-token-from-refresh' },
});

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  mockedS3.storage.reset();
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    artifactCaptureApiKey: KEY,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function session(harness = 'codex', channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, harness)
     VALUES ($1,$2,$3,'profile test','running',$4,$5) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId, harness],
  );
  return r.rows[0]!.id;
}

async function sessionThreadKey(sessionId: string): Promise<string> {
  const r = await pool.query<{ centaur_thread_key: string }>(
    'SELECT centaur_thread_key FROM sessions WHERE id = $1',
    [sessionId],
  );
  return r.rows[0]!.centaur_thread_key;
}

async function loginCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0]! : String(cookie);
}

function codexProposal() {
  return {
    provider: 'codex',
    adapterVersion: 'centaur-test',
    sourceHashes: [{ path: '.codex/config.toml', sha256: SHA, sizeBytes: 100 }],
    manifest: {
      settings: {
        model: 'gpt-5',
        model_reasoning_effort: 'high',
        api_key: 'sk-this-secret-must-not-persist-1234567890',
      },
      mcpServers: {
        safe: {
          url: 'https://mcp.example.test',
          bearer_token_env_var: 'SAFE_MCP_TOKEN',
        },
      },
      bundles: [{ path: 'skills/review/SKILL.md', role: 'skill', sha256: SHA, sizeBytes: 44 }],
    },
  };
}

function canonicalCentaurProposal() {
  return {
    provider: 'codex',
    adapterVersion: 'centaur-node-sync/profile-candidates/v1',
    sourceHashes: [{ path: '.codex/config.toml', sha256: SHA }],
    manifest: {
      settings: { model: 'gpt-5' },
      mcpServers: {
        safe: {
          command: 'mcp-safe',
          env_names: ['SAFE_MCP_TOKEN'],
        },
      },
      excluded: [
        {
          source_path: '.codex/config.toml',
          key_path: 'mcp_servers.safe.env.SAFE_MCP_TOKEN',
          reason: 'literal_env_value',
        },
      ],
    },
    riskSummary: {
      labels: ['safe', 'needs-secret-ref'],
      blockedSecrets: 1,
      executableItems: 0,
      unsupportedItems: 0,
      warnings: ['SAFE_MCP_TOKEN must be supplied from the credential store'],
    },
  };
}

function legacyCentaurProposal() {
  return {
    provider: 'codex',
    adapter_version: 'centaur-node-sync/profile-candidates/v0',
    candidates: [
      {
        source_path: '.codex/config.toml',
        source_kind: 'config',
        config: {
          model: 'gpt-5',
          mcp_servers: {
            search: {
              command: 'mcp-search',
              env_names: ['SEARCH_TOKEN'],
            },
          },
        },
      },
    ],
    excluded: [{ source_path: '.codex/config.toml', key_path: 'api_key', reason: 'literal_secret_field' }],
    manifest: {
      source_file_hashes: [{ path: '.codex/config.toml', hash: SHA }],
    },
    risk_summary: {
      redacted_value_count: 1,
      warnings: ['legacy warning'],
    },
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baselinePayload() {
  return {
    adapterVersion: 'baseline-test',
    manifest: {
      settings: {
        model: 'gpt-4',
        approval_policy: 'on-request',
        removed_setting: true,
      },
      mcpServers: {
        safe: { command: 'mcp-old', env_names: ['SAFE_MCP_TOKEN'] },
        removed: { command: 'mcp-removed' },
      },
    },
  };
}

describe('agent profile candidate ingest', () => {
  it('stores a redacted pending proposal outside artifacts', async () => {
    const sid = await session('codex');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    expect(res.statusCode).toBe(200);
    const proposal = res.json().proposal;
    expect(proposal.provider).toBe('codex');
    expect(proposal.proposal.manifest.settings.model).toBe('gpt-5');
    expect(proposal.proposal.manifest.settings.api_key).toBeUndefined();
    expect(proposal.proposal.manifest.mcpServers.safe.bearer_token_env_var).toBe('SAFE_MCP_TOKEN');
    expect(proposal.riskSummary.blockedSecrets).toBeGreaterThan(0);

    const artifactRows = await pool.query('SELECT 1 FROM artifacts');
    expect(artifactRows.rowCount).toBe(0);

    const cookie = await loginCookie();
    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/profile-change-proposals`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().proposals).toHaveLength(1);
  });

  it('preserves Centaur sanitized risk counts and source hashes', async () => {
    const sid = await session('codex');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: canonicalCentaurProposal(),
    });

    expect(res.statusCode).toBe(200);
    const proposal = res.json().proposal;
    expect(proposal.proposal.sourceHashes).toEqual([{ path: '.codex/config.toml', sha256: SHA }]);
    expect(proposal.proposal.manifest.mcpServers.safe.env_names).toEqual(['SAFE_MCP_TOKEN']);
    expect(proposal.proposal.manifest.excluded[0]).toMatchObject({
      path: '.codex/config.toml',
      key: 'mcp_servers.safe.env.SAFE_MCP_TOKEN',
      reason: 'literal_env_value',
    });
    expect(proposal.riskSummary.blockedSecrets).toBe(1);
    expect(proposal.riskSummary.labels).toContain('needs-secret-ref');
    expect(proposal.riskSummary.warnings).toContain('SAFE_MCP_TOKEN must be supplied from the credential store');
  });

  it('redacts secret-shaped proposal metadata strings before persistence', async () => {
    const sid = await session('codex');
    const secret = 'sk-thismetadata-secret-must-not-persist-1234567890';
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        provider: 'codex',
        adapterVersion: 'centaur-test',
        sourceHashes: [{ path: `.codex/${secret}.toml`, sha256: SHA }],
        manifest: {
          settings: {
            model: 'gpt-5',
            [secret]: 'not secret by value, but unsafe as metadata',
          },
          warnings: [`blocked ${secret}`],
          excluded: [{
            source_path: `.codex/${secret}.toml`,
            key_path: `settings.${secret}`,
            reason: `Bearer ${secret}`,
          }],
          bundles: [{
            path: `skills/${secret}.md`,
            role: secret,
            sha256: SHA,
            sizeBytes: 10,
            warnings: [`bundle ${secret}`],
          }],
        },
        riskSummary: { warnings: [`risk ${secret}`] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(secret);
    expect(res.json().proposal.proposal.manifest.warnings).toContain('profile metadata warning');
    expect(res.json().proposal.proposal.manifest.excluded).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'settings.[redacted-key]' })]),
    );
  });

  it('accepts legacy snake_case candidate reports during rollout', async () => {
    const sid = await session('codex');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: legacyCentaurProposal(),
    });

    expect(res.statusCode).toBe(200);
    const proposal = res.json().proposal;
    expect(proposal.proposal.adapterVersion).toBe('centaur-node-sync/profile-candidates/v0');
    expect(proposal.proposal.sourceHashes).toEqual([{ path: '.codex/config.toml', sha256: SHA }]);
    expect(proposal.proposal.manifest.settings.model).toBe('gpt-5');
    expect(proposal.proposal.manifest.mcpServers.search.env_names).toEqual(['SEARCH_TOKEN']);
    expect(proposal.riskSummary.blockedSecrets).toBe(1);
  });

  it('computes proposal diffs against the session baseline', async () => {
    const sid = await session('codex');
    const baseline = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-baseline?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: baselinePayload(),
    });
    expect(baseline.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        provider: 'codex',
        adapterVersion: 'diff-test',
        manifest: {
          settings: {
            model: 'gpt-5',
            approval_policy: 'on-request',
            new_setting: 42,
          },
          mcpServers: {
            safe: { command: 'mcp-new', env_names: ['SAFE_MCP_TOKEN'] },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.diff).toEqual({
      added: ['settings.new_setting'],
      changed: ['mcpServers.safe.command', 'settings.model'],
      removed: ['mcpServers.removed.command', 'settings.removed_setting'],
    });
    expect(res.json().proposal.proposal.diff).toEqual(res.json().proposal.diff);
  });

  it('marks every current profile key added when there is no baseline', async () => {
    const sid = await session('codex');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        provider: 'codex',
        adapterVersion: 'diff-test',
        manifest: {
          settings: { model: 'gpt-5' },
          mcpServers: { safe: { command: 'mcp-safe' } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.diff).toEqual({
      added: ['mcpServers.safe.command', 'settings.model'],
      changed: [],
      removed: [],
    });
  });

  it('rejects denied paths in profile baselines', async () => {
    const sid = await session('codex');
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-baseline?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        adapterVersion: 'baseline-test',
        manifest: {
          bundles: [{ path: '.codex/auth.json', role: 'config', sha256: SHA, sizeBytes: 10 }],
        },
      },
    });

    expect(denied.statusCode).toBe(400);
  });

  it('stores profile candidates when addressed by centaur_thread_key', async () => {
    const sid = await session('codex');
    const threadKey = await sessionThreadKey(sid);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${threadKey}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.sessionId).toBe(sid);

    const rows = await pool.query<{ session_id: string }>(
      'SELECT session_id FROM session_profile_change_proposals WHERE session_id = $1',
      [sid],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('rejects profile candidates for the wrong session harness', async () => {
    const sid = await session('claude-code');
    const threadKey = await sessionThreadKey(sid);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${threadKey}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects centaur_thread_key profile candidates without the internal api key', async () => {
    const sid = await session('codex');
    const threadKey = await sessionThreadKey(sid);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${threadKey}/profile-candidates?harness=codex`,
      payload: codexProposal(),
    });

    expect(res.statusCode).toBe(401);
  });

  it('can apply a proposal to lineage or save it as a new immutable profile version', async () => {
    const sid = await session('codex');
    const ingest = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    const proposalId = ingest.json().proposal.id as string;
    const cookie = await loginCookie();

    const apply = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${proposalId}/apply-lineage`,
      headers: { cookie },
      payload: {},
    });
    expect(apply.statusCode).toBe(200);
    const lineage = await pool.query<{ runtime_overlay_json: Record<string, string> }>(
      'SELECT runtime_overlay_json FROM session_profile_snapshots WHERE session_id = $1',
      [sid],
    );
    expect(lineage.rows[0]?.runtime_overlay_json.CODEX_CONFIG_OVERLAY).toContain('model = "gpt-5"');

    const ingestAgain = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    const save = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${ingestAgain.json().proposal.id}/save-new-profile`,
      headers: { cookie },
      payload: { name: 'Team Codex' },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().profile.name).toBe('Team Codex');
    expect(save.json().version.runtimeOverlay.CODEX_CONFIG_OVERLAY).toContain('mcp_servers');
    const active = await pool.query<{ agent_profile_version_id: string | null }>(
      'SELECT agent_profile_version_id FROM sessions WHERE id = $1',
      [sid],
    );
    expect(active.rows[0]?.agent_profile_version_id).toBe(save.json().version.id);

    const ingestAfterSave = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    expect(ingestAfterSave.json().proposal.baseProfileVersionId).toBe(save.json().version.id);
  });

  it('requires proposal actions to match the route session id', async () => {
    const sid = await session('codex');
    const otherSid = await session('codex');
    const ingest = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    const cookie = await loginCookie();

    const wrongSession = await app.inject({
      method: 'POST',
      url: `/api/sessions/${otherSid}/profile-change-proposals/${ingest.json().proposal.id}/discard`,
      headers: { cookie },
      payload: {},
    });

    expect(wrongSession.statusCode).toBe(404);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/profile-change-proposals`,
      headers: { cookie },
    });
    expect(listed.json().proposals[0].status).toBe('pending');
  });

  it('requires current private-channel access for proposal reads and actions', async () => {
    const channel = await pool.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, name, kind, created_by)
       VALUES ($1, $2, 'private', $3)
       RETURNING id`,
      [fx.workspaceId, `profile-private-${randomUUID()}`, fx.userId],
    );
    const channelId = channel.rows[0]!.id;
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [
      channelId,
      fx.userId,
    ]);
    const sid = await session('codex', channelId);
    const ingest = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    expect(ingest.statusCode).toBe(200);
    const cookie = await loginCookie();

    await pool.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [
      channelId,
      fx.userId,
    ]);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/profile-change-proposals`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(404);

    const discarded = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${ingest.json().proposal.id}/discard`,
      headers: { cookie },
      payload: {},
    });
    expect(discarded.statusCode).toBe(404);
  });

  it('rejects saving into a profile that changed after proposal capture', async () => {
    const sid = await session('codex');
    const cookie = await loginCookie();
    const first = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    const saved = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${first.json().proposal.id}/save-new-profile`,
      headers: { cookie },
      payload: { name: 'Team Codex' },
    });
    expect(saved.statusCode).toBe(200);

    const second = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    const changedProposal = codexProposal();
    changedProposal.manifest.settings.model = 'gpt-5-mini';
    const updatedVersion = await app.inject({
      method: 'POST',
      url: `/api/me/agent-profiles/${saved.json().profile.id}/versions`,
      headers: { cookie },
      payload: changedProposal,
    });
    expect(updatedVersion.statusCode).toBe(200);

    const staleSave = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${second.json().proposal.id}/save-current-profile`,
      headers: { cookie },
      payload: { profileId: saved.json().profile.id },
    });
    expect(staleSave.statusCode).toBe(409);
  });
});

describe('harness-state bundle and credential refresh prerequisites', () => {
  it('round-trips profile bundle blobs through CAS', async () => {
    const sid = await session('codex');
    const bytes = Buffer.from('profile bundle bytes\n');
    const bundleSha = sha256(bytes);
    const stored = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-bundle-blob?sha256=${bundleSha}&path=${encodeURIComponent('skills/review/SKILL.md')}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({ sha256: bundleSha, size_bytes: bytes.length });

    const loaded = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/profile-bundle-blob?sha256=${bundleSha}`,
      headers: { 'x-api-key': KEY },
    });
    expect(loaded.statusCode).toBe(200);
    expect(Buffer.from(loaded.rawPayload)).toEqual(bytes);
  });

  it('rejects profile bundle blob sha mismatches and denied paths', async () => {
    const sid = await session('codex');
    const bytes = Buffer.from('profile bundle bytes\n');
    const mismatch = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-bundle-blob?sha256=${'0'.repeat(64)}&path=${encodeURIComponent('skills/review/SKILL.md')}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(mismatch.statusCode).toBe(400);

    const deniedSha = sha256(bytes);
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-bundle-blob?sha256=${deniedSha}&path=${encodeURIComponent('.codex/auth.json')}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(denied.statusCode).toBe(400);
  });

  it("returns the bound profile version's functional bundles", async () => {
    const sid = await session('codex');
    const cookie = await loginCookie();
    const ingest = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/profile-candidates?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: codexProposal(),
    });
    expect(ingest.statusCode).toBe(200);
    const save = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/profile-change-proposals/${ingest.json().proposal.id}/save-new-profile`,
      headers: { cookie },
      payload: { name: 'Team Codex' },
    });
    expect(save.statusCode).toBe(200);

    const bundles = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/profile-bundles?harness=codex`,
      headers: { 'x-api-key': KEY },
    });
    expect(bundles.statusCode).toBe(200);
    expect(bundles.json()).toEqual({
      bundles: [{ path: 'skills/review/SKILL.md', sha256: SHA, role: 'skill', executable: false }],
    });
  });

  it('stores safe harness-state bundle metadata and rejects credential-shaped paths', async () => {
    const sid = await session('codex');
    const safe = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-state-bundle?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        adapterVersion: 'test',
        manifest: { files: [{ path: '.codex/sessions/2026/06/25/rollout-thread.jsonl', sha256: SHA }] },
      },
    });
    expect(safe.statusCode).toBe(200);

    const loaded = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-state-bundle?harness=codex`,
      headers: { 'x-api-key': KEY },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().manifest.files[0].path).toContain('rollout-thread.jsonl');

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-state-bundle?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: { manifest: { files: [{ path: '.codex/auth.json', sha256: SHA }] } },
    });
    expect(denied.statusCode).toBe(400);
  });

  it('refreshes provider credentials only through the encrypted credential store', async () => {
    const sid = await session('codex');
    const refreshed = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/provider-credential-refresh?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: { authJson: CODEX_AUTH_JSON },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().provider).toMatchObject({ provider: 'codex', connected: true });
    expect(JSON.stringify(refreshed.json())).not.toContain('codex-access-token-from-refresh');

    const rows = await pool.query<{ token_ciphertext: string }>(
      `SELECT token_ciphertext FROM user_provider_credentials WHERE user_id = $1 AND provider = 'codex'`,
      [fx.userId],
    );
    expect(rows.rows[0]?.token_ciphertext).toBeTruthy();
    expect(rows.rows[0]?.token_ciphertext).not.toContain('codex-access-token-from-refresh');

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/provider-credential-refresh?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: { authJson: JSON.stringify({ auth_mode: 'api_key', OPENAI_API_KEY: 'sk-nope' }) },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// Regression for the bugs the live producer E2E exposed: the real node-sync daemon
// always addresses sessions by centaur_thread_key (not a uuid), and its real payloads
// carry sha256 file hashes + an `excluded` list naming the denied auth.json.
describe('#97 fix-forward: thread-key resolution + real producer payload shapes', () => {
  it('provider-credential-refresh resolves the session by centaur_thread_key', async () => {
    const sid = await session('codex');
    const tk = await sessionThreadKey(sid);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${tk}/provider-credential-refresh?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: { authJson: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-abc' } }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toMatchObject({ provider: 'codex', connected: true });
  });

  it('harness-state-bundle resolves by thread key and accepts a manifest of sha256 file hashes', async () => {
    const sid = await session('codex');
    const tk = await sessionThreadKey(sid);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${tk}/harness-state-bundle?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        adapterVersion: 'centaur-test',
        manifest: {
          files: [
            { path: '.codex/sessions/2026/06/25/rollout-thread.jsonl', sha256: SHA, sizeBytes: 120, role: 'transcript' },
          ],
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${tk}/harness-state-bundle?harness=codex`,
      headers: { 'x-api-key': KEY },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().manifest.files[0].path).toContain('rollout-thread.jsonl');
  });

  it('profile-baseline (thread-key) accepts a payload whose excluded list names the denied auth.json', async () => {
    const sid = await session('codex');
    const tk = await sessionThreadKey(sid);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${tk}/profile-baseline?harness=codex`,
      headers: { 'x-api-key': KEY },
      payload: {
        provider: 'codex',
        adapterVersion: 'centaur-test',
        manifest: {
          settings: { model: 'gpt-5' },
          excluded: [{ path: '.codex/auth.json', reason: 'denied' }],
          sourceHashes: [{ path: '.codex/config.toml', sha256: SHA }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
