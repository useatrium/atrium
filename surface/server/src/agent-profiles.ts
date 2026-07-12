import { createHash } from 'node:crypto';
import type {
  AgentProfile,
  AgentProfileDiff,
  AgentProfileManifest,
  AgentProfileProposal,
  AgentProfileProposalPayload,
  AgentProfileRiskLabel,
  AgentProfileRiskSummary,
  AgentProfileVersion,
  AgentProfileProvider,
} from '@atrium/surface-client/agentProfiles';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { canAccessChannel, DomainError } from './events.js';
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_PROVIDER,
  isProviderCredentialProvider,
  type ProviderCredentialProvider,
} from './provider-credentials.js';

type Queryable = Pick<Db | DbClient, 'query'>;

const ADAPTER_VERSION_FALLBACK = 'atrium-v0';
const MAX_PROFILE_JSON_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024;
export const PROFILE_BUNDLES_NOTIFY_CHANNEL = 'profile_bundles_advanced';

const SECRET_KEY_RE =
  /(api[_-]?key|auth|bearer|client[_-]?secret|credential|oauth|password|private[_-]?key|refresh[_-]?token|secret|token)/i;
const SECRET_VALUE_RE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/;
const SAFE_ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

interface ProposalRow {
  id: string;
  session_id: string | null;
  provider: AgentProfileProvider;
  base_profile_version_id: string | null;
  adapter_version: string;
  proposal_json: AgentProfileProposalPayload;
  risk_summary_json: AgentProfileRiskSummary;
  status: AgentProfileProposal['status'];
  source: AgentProfileProposal['source'];
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

interface ProfileRow {
  id: string;
  provider: AgentProfileProvider;
  name: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  profile_id: string;
  provider: AgentProfileProvider;
  adapter_version: string;
  manifest_json: AgentProfileManifest;
  runtime_overlay_json: Record<string, unknown>;
  content_hash: string;
  created_at: Date;
}

export class AgentProfiles {
  constructor(private readonly pool: Db) {}

  async ingestSessionProposal(
    sessionId: string,
    provider: AgentProfileProvider,
    raw: unknown,
  ): Promise<AgentProfileProposal> {
    const proposal = normalizeProposal(provider, raw);
    return withTx(this.pool, async (client) => {
      const session = await client.query<{
        spawned_by: string;
        harness: string | null;
        agent_profile_version_id: string | null;
      }>('SELECT spawned_by, harness, agent_profile_version_id FROM sessions WHERE id = $1 FOR UPDATE', [
        sessionId,
      ]);
      const found = session.rows[0];
      if (!found) throw new DomainError(404, 'session_not_found', 'session not found');
      const sessionProvider = providerForHarnessValue(found.harness);
      if (!sessionProvider || sessionProvider !== provider) {
        throw new DomainError(400, 'harness_provider_mismatch', 'profile candidates do not match session harness');
      }
      const snapshot = await client.query<{
        profile_version_id: string | null;
        baseline_manifest_json: AgentProfileManifest | null;
      }>(
        `SELECT profile_version_id, baseline_manifest_json
         FROM session_profile_snapshots
         WHERE session_id = $1 AND provider = $2`,
        [sessionId, provider],
      );
      const baseProfileVersionId =
        snapshot.rows.length > 0 ? snapshot.rows[0]!.profile_version_id : found.agent_profile_version_id;
      proposal.diff = diffManifests(snapshot.rows[0]?.baseline_manifest_json ?? null, proposal.manifest);
      const contentHash = sha256(stableStringify(proposal));

      const inserted = await client.query<ProposalRow>(
        `INSERT INTO session_profile_change_proposals (
           session_id, user_id, provider, base_profile_version_id, adapter_version,
           proposal_json, risk_summary_json, content_hash, source
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 'session')
         ON CONFLICT (session_id, provider) WHERE status = 'pending' AND session_id IS NOT NULL
         DO UPDATE SET
           base_profile_version_id = EXCLUDED.base_profile_version_id,
           adapter_version = EXCLUDED.adapter_version,
           proposal_json = EXCLUDED.proposal_json,
           risk_summary_json = EXCLUDED.risk_summary_json,
           content_hash = EXCLUDED.content_hash,
           updated_at = now()
         RETURNING *`,
        [
          sessionId,
          found.spawned_by,
          provider,
          baseProfileVersionId,
          proposal.adapterVersion,
          JSON.stringify(proposal),
          JSON.stringify(proposal.riskSummary),
          contentHash,
        ],
      );
      return proposalFromRow(inserted.rows[0]!);
    });
  }

  async putSessionBaseline(
    sessionId: string,
    provider: AgentProfileProvider,
    raw: unknown,
  ): Promise<{ baselineHash: string }> {
    assertNoDeniedProfilePaths(raw);
    const proposal = normalizeProposal(provider, raw);
    const baselineHash = sha256(stableStringify(proposal.manifest));
    await withTx(this.pool, async (client) => {
      const session = await client.query<{ harness: string | null }>(
        'SELECT harness FROM sessions WHERE id = $1 FOR UPDATE',
        [sessionId],
      );
      const found = session.rows[0];
      if (!found) throw new DomainError(404, 'session_not_found', 'session not found');
      const sessionProvider = providerForHarnessValue(found.harness);
      if (!sessionProvider || sessionProvider !== provider) {
        throw new DomainError(400, 'harness_provider_mismatch', 'profile baseline does not match session harness');
      }
      await client.query(
        `INSERT INTO session_profile_snapshots (
           session_id, provider, profile_version_id, adapter_version, baseline_hash,
           baseline_manifest_json, runtime_overlay_json
         )
         VALUES ($1, $2, NULL, $3, $4, $5::jsonb, '{}'::jsonb)
         ON CONFLICT (session_id, provider) DO UPDATE SET
           adapter_version = EXCLUDED.adapter_version,
           baseline_hash = EXCLUDED.baseline_hash,
           baseline_manifest_json = EXCLUDED.baseline_manifest_json,
           updated_at = now()`,
        [
          sessionId,
          provider,
          proposal.adapterVersion,
          baselineHash,
          JSON.stringify(proposal.manifest),
        ],
      );
    });
    return { baselineHash };
  }

  async createImportProposal(
    userId: string,
    provider: AgentProfileProvider,
    raw: unknown,
  ): Promise<AgentProfileProposal> {
    const proposal = normalizeProposal(provider, raw);
    const contentHash = sha256(stableStringify(proposal));
    const inserted = await this.pool.query<ProposalRow>(
      `INSERT INTO session_profile_change_proposals (
         session_id, user_id, provider, adapter_version, proposal_json,
         risk_summary_json, content_hash, source
       )
       VALUES (NULL, $1, $2, $3, $4::jsonb, $5::jsonb, $6, 'local_import')
       RETURNING *`,
      [
        userId,
        provider,
        proposal.adapterVersion,
        JSON.stringify(proposal),
        JSON.stringify(proposal.riskSummary),
        contentHash,
      ],
    );
    return proposalFromRow(inserted.rows[0]!);
  }

  async listSessionProposals(
    sessionId: string,
    userId: string,
  ): Promise<AgentProfileProposal[]> {
    await assertSessionReadable(this.pool, sessionId, userId);
    const rows = await this.pool.query<ProposalRow>(
      `SELECT * FROM session_profile_change_proposals
       WHERE session_id = $1 AND user_id = $2
       ORDER BY created_at DESC`,
      [sessionId, userId],
    );
    return rows.rows.map(proposalFromRow);
  }

  async listProfiles(userId: string): Promise<AgentProfile[]> {
    const rows = await this.pool.query<ProfileRow>(
      `SELECT id, provider, name, current_version_id, created_at, updated_at
       FROM agent_profiles
       WHERE user_id = $1
       ORDER BY provider, lower(name), updated_at DESC`,
      [userId],
    );
    const versions = await this.currentVersionsFor(userId);
    return rows.rows.map((row) => profileFromRow(row, versions.get(row.current_version_id ?? '')));
  }

  async getProfile(userId: string, profileId: string): Promise<AgentProfile> {
    const profile = await this.pool.query<ProfileRow>(
      `SELECT id, provider, name, current_version_id, created_at, updated_at
       FROM agent_profiles
       WHERE id = $1 AND user_id = $2`,
      [profileId, userId],
    );
    const row = profile.rows[0];
    if (!row) throw new DomainError(404, 'profile_not_found', 'profile not found');
    const version = row.current_version_id
      ? await this.loadVersionForUser(userId, row.current_version_id)
      : null;
    return profileFromRow(row, version);
  }

  async createProfile(
    userId: string,
    provider: AgentProfileProvider,
    name: string,
  ): Promise<AgentProfile> {
    const trimmed = normalizeName(name, provider);
    const row = await this.pool.query<ProfileRow>(
      `INSERT INTO agent_profiles (user_id, provider, name)
       VALUES ($1, $2, $3)
       RETURNING id, provider, name, current_version_id, created_at, updated_at`,
      [userId, provider, trimmed],
    );
    return profileFromRow(row.rows[0]!, null);
  }

  async createVersion(
    userId: string,
    profileId: string,
    raw: unknown,
  ): Promise<AgentProfileVersion> {
    return withTx(this.pool, async (client) => {
      const profile = await requireProfile(client, userId, profileId);
      const proposal = normalizeProposal(profile.provider, raw);
      return createVersionFromProposal(client, userId, profile.id, proposal);
    });
  }

  async discardProposal(
    userId: string,
    sessionId: string,
    proposalId: string,
  ): Promise<AgentProfileProposal> {
    return this.transitionProposal(userId, sessionId, proposalId, 'discarded');
  }

  async applyProposalToLineage(
    userId: string,
    sessionId: string,
    proposalId: string,
  ): Promise<AgentProfileProposal> {
    return withTx(this.pool, async (client) => {
      const proposal = await requirePendingSessionProposal(client, userId, sessionId, proposalId);
      const payload = proposal.proposal_json;
      const runtimeOverlay = runtimeOverlayFromManifest(payload.manifest);
      await client.query(
        `INSERT INTO session_profile_snapshots (
           session_id, provider, profile_version_id, adapter_version, baseline_hash,
           baseline_manifest_json, runtime_overlay_json
         )
         VALUES ($1, $2, NULL, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (session_id, provider) DO UPDATE SET
           profile_version_id = NULL,
           adapter_version = EXCLUDED.adapter_version,
           baseline_hash = EXCLUDED.baseline_hash,
           baseline_manifest_json = EXCLUDED.baseline_manifest_json,
           runtime_overlay_json = EXCLUDED.runtime_overlay_json,
           updated_at = now()`,
        [
          proposal.session_id,
          proposal.provider,
          payload.adapterVersion,
          sha256(stableStringify(payload.manifest)),
          JSON.stringify(payload.manifest),
          JSON.stringify(runtimeOverlay),
        ],
      );
      await client.query('UPDATE sessions SET agent_profile_version_id = NULL WHERE id = $1', [sessionId]);
      if (proposal.session_id) await notifyProfileBundlesAdvanced(client, proposal.session_id, proposal.provider);
      return updateProposalStatus(client, proposalId, userId, 'applied_to_lineage');
    });
  }

  async saveProposalToCurrentProfile(
    userId: string,
    sessionId: string,
    proposalId: string,
    opts: { profileId?: string; name?: string } = {},
  ): Promise<{ proposal: AgentProfileProposal; profile: AgentProfile; version: AgentProfileVersion }> {
    return withTx(this.pool, async (client) => {
      const proposal = await requirePendingSessionProposal(client, userId, sessionId, proposalId);
      const profileId =
        opts.profileId ?? (await profileIdFromBaseVersion(client, userId, proposal.base_profile_version_id));
      const profile = profileId
        ? await requireProfile(client, userId, profileId)
        : await insertProfile(client, userId, proposal.provider, normalizeName(opts.name, proposal.provider));
      if (profile.provider !== proposal.provider) {
        throw new DomainError(400, 'profile_provider_mismatch', 'profile does not match proposal provider');
      }
      if (profile.current_version_id !== proposal.base_profile_version_id) {
        throw new DomainError(409, 'profile_version_conflict', 'profile changed after this proposal was captured');
      }
      return saveProposalAsProfile(client, userId, sessionId, proposalId, proposal, profile);
    });
  }

  async saveProposalToNewProfile(
    userId: string,
    sessionId: string,
    proposalId: string,
    name: string,
  ): Promise<{ proposal: AgentProfileProposal; profile: AgentProfile; version: AgentProfileVersion }> {
    return withTx(this.pool, async (client) => {
      const proposal = await requirePendingSessionProposal(client, userId, sessionId, proposalId);
      const profile = await insertProfile(client, userId, proposal.provider, normalizeName(name, proposal.provider));
      return saveProposalAsProfile(client, userId, sessionId, proposalId, proposal, profile);
    });
  }

  async resolveVersionForSpawn(
    client: Queryable,
    args: {
      userId: string;
      provider: ProviderCredentialProvider | null;
      profileId?: string | null;
      profileVersionId?: string | null;
    },
  ): Promise<AgentProfileVersion | null> {
    if (!args.provider) return null;
    const profileVersionId = normalizeOptionalId(args.profileVersionId);
    const profileId = normalizeOptionalId(args.profileId);
    if (!profileVersionId && !profileId) return null;

    if (profileVersionId) {
      const version = await loadVersionForUser(client, args.userId, profileVersionId);
      if (!version || version.provider !== args.provider) {
        throw new DomainError(400, 'profile_provider_mismatch', 'profile version does not match harness');
      }
      return version;
    }

    const profile = await requireProfile(client, args.userId, profileId!);
    if (profile.provider !== args.provider) {
      throw new DomainError(400, 'profile_provider_mismatch', 'profile does not match harness');
    }
    if (!profile.current_version_id) {
      throw new DomainError(400, 'profile_has_no_version', 'profile has no saved version');
    }
    return loadVersionForUser(client, args.userId, profile.current_version_id);
  }

  async bindSessionProfileSnapshot(
    client: Queryable,
    sessionId: string,
    version: AgentProfileVersion | null,
  ): Promise<void> {
    if (!version) return;
    await bindSessionSnapshot(client, sessionId, version);
  }

  async environmentForSession(
    sessionId: string,
    provider: AgentProfileProvider,
  ): Promise<Record<string, string> | undefined> {
    const snap = await this.pool.query<{
      runtime_overlay_json: Record<string, unknown>;
    }>(
      `SELECT runtime_overlay_json
       FROM session_profile_snapshots
       WHERE session_id = $1 AND provider = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId, provider],
    );
    const overlay = snap.rows[0]?.runtime_overlay_json;
    if (!overlay) return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(overlay)) {
      if (typeof value === 'string' && value.length > 0) env[key] = value;
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  private async transitionProposal(
    userId: string,
    sessionId: string,
    proposalId: string,
    status: AgentProfileProposal['status'],
  ): Promise<AgentProfileProposal> {
    return withTx(this.pool, async (client) => {
      await requirePendingSessionProposal(client, userId, sessionId, proposalId);
      return updateProposalStatus(client, proposalId, userId, status);
    });
  }

  private async currentVersionsFor(userId: string): Promise<Map<string, AgentProfileVersion>> {
    const rows = await this.pool.query<VersionRow>(
      `SELECT v.*
       FROM agent_profile_versions v
       JOIN agent_profiles p ON p.current_version_id = v.id
       WHERE p.user_id = $1`,
      [userId],
    );
    return new Map(rows.rows.map((row) => [row.id, versionFromRow(row)]));
  }

  private async loadVersionForUser(
    userId: string,
    versionId: string,
  ): Promise<AgentProfileVersion | null> {
    return loadVersionForUser(this.pool, userId, versionId);
  }
}

export function providerFromProfileValue(value: unknown): AgentProfileProvider | null {
  return typeof value === 'string' && isProviderCredentialProvider(value)
    ? value
    : null;
}

function providerForHarnessValue(value: unknown): AgentProfileProvider | null {
  if (value === CODEX_PROVIDER) return CODEX_PROVIDER;
  if (value === 'claude' || value === CLAUDE_CODE_PROVIDER) return CLAUDE_CODE_PROVIDER;
  return null;
}

export function normalizeProposal(
  provider: AgentProfileProvider,
  raw: unknown,
): AgentProfileProposalPayload {
  const root = asRecord(raw);
  const rawProvider = providerFromProfileValue(root.provider);
  if (rawProvider && rawProvider !== provider) {
    throw new DomainError(400, 'provider_mismatch', 'proposal provider does not match request');
  }
  const rawManifestRoot = asRecord(root.manifest);
  const legacyManifest = legacyManifestFromCandidates(root.candidates);
  const rawManifest: Record<string, unknown> = {
    ...rawManifestRoot,
    settings: rawManifestRoot.settings ?? legacyManifest.settings,
    mcpServers: rawManifestRoot.mcpServers ?? rawManifestRoot.mcp_servers ?? legacyManifest.mcpServers,
    excluded: rawManifestRoot.excluded ?? root.excluded,
    warnings: rawManifestRoot.warnings ?? root.warnings,
  };
  const adapterVersion = normalizeShortString(
    root.adapterVersion ?? root.adapter_version ?? rawManifest.adapterVersion ?? rawManifest.adapter_version,
    ADAPTER_VERSION_FALLBACK,
    80,
  );
  const rawRisk = asRecord(root.riskSummary ?? root.risk_summary);
  const excluded = normalizeExcluded(rawManifest.excluded);
  const warnings = normalizeSafeStringArray(rawManifest.warnings, 64, 'profile metadata warning');
  warnings.push(...normalizeSafeStringArray(rawRisk.warnings, 64, 'profile risk warning'));

  const settings = sanitizeProfileObject(rawManifest.settings, ['settings']);
  const mcpServers = sanitizeProfileObject(rawManifest.mcpServers, ['mcpServers']);
  const bundles = normalizeBundles(rawManifest.bundles, excluded, warnings);
  const labels = new Set<AgentProfileRiskLabel>(['safe']);
  let blockedSecrets = settings.blockedSecrets + mcpServers.blockedSecrets;
  blockedSecrets = Math.max(
    blockedSecrets,
    normalizeCount(rawRisk.blockedSecrets ?? rawRisk.blocked_secrets ?? rawRisk.redacted_value_count),
  );
  for (const result of [settings, mcpServers]) {
    for (const item of result.excluded) excluded.push(item);
    for (const warning of result.warnings) warnings.push(warning);
  }

  for (const label of normalizeRiskLabels(rawRisk.labels)) labels.add(label);
  if (blockedSecrets > 0) labels.add('needs-secret-ref');
  const executableItems = Math.max(
    bundles.filter((bundle) => bundle.executable).length,
    normalizeCount(rawRisk.executableItems ?? rawRisk.executable_items),
  );
  if (executableItems > 0) labels.add('policy-capped');
  const unsupportedItems = Math.max(
    excluded.filter((item) => item.reason === 'unsupported').length,
    normalizeCount(rawRisk.unsupportedItems ?? rawRisk.unsupported_items),
  );
  if (unsupportedItems > 0) labels.add('unsupported');

  const manifest: AgentProfileManifest = {
    provider,
    adapterVersion,
    ...(Object.keys(settings.value).length > 0 ? { settings: settings.value } : {}),
    ...(Object.keys(mcpServers.value).length > 0 ? { mcpServers: mcpServers.value } : {}),
    ...(bundles.length > 0 ? { bundles } : {}),
    ...(excluded.length > 0 ? { excluded } : {}),
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)].slice(0, 64) } : {}),
  };
  const riskSummary: AgentProfileRiskSummary = {
    labels: [...labels],
    blockedSecrets,
    executableItems,
    unsupportedItems,
    warnings: [...new Set(warnings)].slice(0, 64),
  };
  const proposal: AgentProfileProposalPayload = {
    provider,
    adapterVersion,
    sourceHashes: normalizeSourceHashes(
      root.sourceHashes ?? root.source_hashes ?? rawManifest.sourceHashes ?? rawManifest.source_file_hashes,
    ),
    manifest,
    riskSummary,
    baselineHash:
      typeof root.baselineHash === 'string' && root.baselineHash.trim()
        ? root.baselineHash.trim().slice(0, 128)
        : null,
  };
  const size = Buffer.byteLength(stableStringify(proposal), 'utf8');
  if (size > MAX_PROFILE_JSON_BYTES) {
    throw new DomainError(413, 'profile_proposal_too_large', 'profile proposal is too large');
  }
  return proposal;
}

function legacyManifestFromCandidates(value: unknown): {
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
} {
  if (!Array.isArray(value)) return {};
  const settings: Record<string, unknown> = {};
  const mcpServers: Record<string, unknown> = {};
  for (const candidate of value.slice(0, 128)) {
    const config = asRecord(asRecord(candidate).config);
    for (const [key, child] of Object.entries(config)) {
      if (key === 'mcp_servers' || key === 'mcpServers') {
        Object.assign(mcpServers, asRecord(child));
      } else {
        settings[key] = child;
      }
    }
  }
  return {
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  };
}

export function containsProfileSecret(value: unknown): boolean {
  if (typeof value === 'string') return looksSecretValue(value);
  if (Array.isArray(value)) return value.some(containsProfileSecret);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => metadataKeyContainsSecret(key) || containsProfileSecret(child),
    );
  }
  return false;
}

function runtimeOverlayFromManifest(manifest: AgentProfileManifest): Record<string, string> {
  if (manifest.provider === CODEX_PROVIDER) {
    const overlay: Record<string, unknown> = {
      ...(manifest.settings ?? {}),
      ...(manifest.mcpServers ? { mcp_servers: manifest.mcpServers } : {}),
    };
    return Object.keys(overlay).length > 0
      ? { CODEX_CONFIG_OVERLAY: toToml(overlay) }
      : {};
  }
  const out: Record<string, string> = {};
  if (manifest.settings && Object.keys(manifest.settings).length > 0) {
    out.CLAUDE_SETTINGS_OVERLAY = JSON.stringify(manifest.settings);
  }
  if (manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0) {
    out.CLAUDE_USER_CONFIG_OVERLAY = JSON.stringify({ mcpServers: manifest.mcpServers });
  }
  return out;
}

async function saveProposalAsProfile(
  client: Queryable,
  userId: string,
  sessionId: string,
  proposalId: string,
  proposal: ProposalRow,
  profile: ProfileRow,
): Promise<{ proposal: AgentProfileProposal; profile: AgentProfile; version: AgentProfileVersion }> {
  const version = await createVersionFromProposal(client, userId, profile.id, proposal.proposal_json);
  await bindSessionSnapshot(client, sessionId, version, true);
  const updated = await updateProposalStatus(client, proposalId, userId, 'saved_profile');
  return {
    proposal: updated,
    profile: profileFromRow({ ...profile, current_version_id: version.id, updated_at: new Date() }, version),
    version,
  };
}

async function createVersionFromProposal(
  client: Queryable,
  userId: string,
  profileId: string,
  proposal: AgentProfileProposalPayload,
): Promise<AgentProfileVersion> {
  const runtimeOverlay = runtimeOverlayFromManifest(proposal.manifest);
  const contentHash = sha256(stableStringify({ manifest: proposal.manifest, runtimeOverlay }));
  const row = await client.query<VersionRow>(
    `INSERT INTO agent_profile_versions (
       profile_id, provider, adapter_version, manifest_json, runtime_overlay_json,
       content_hash, created_by
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (profile_id, content_hash) DO UPDATE SET
       adapter_version = agent_profile_versions.adapter_version
     RETURNING *`,
    [
      profileId,
      proposal.provider,
      proposal.adapterVersion,
      JSON.stringify(proposal.manifest),
      JSON.stringify(runtimeOverlay),
      contentHash,
      userId,
    ],
  );
  const version = versionFromRow(row.rows[0]!);
  await client.query(
    'UPDATE agent_profiles SET current_version_id = $1, updated_at = now() WHERE id = $2',
    [version.id, profileId],
  );
  return version;
}

async function bindSessionSnapshot(
  client: Queryable,
  sessionId: string,
  version: AgentProfileVersion,
  advanceSessionVersion = false,
): Promise<void> {
  await client.query(
    `INSERT INTO session_profile_snapshots (
       session_id, provider, profile_version_id, adapter_version, baseline_hash,
       baseline_manifest_json, runtime_overlay_json
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (session_id, provider) DO UPDATE SET
       profile_version_id = EXCLUDED.profile_version_id,
       adapter_version = EXCLUDED.adapter_version,
       baseline_hash = EXCLUDED.baseline_hash,
       baseline_manifest_json = EXCLUDED.baseline_manifest_json,
       runtime_overlay_json = EXCLUDED.runtime_overlay_json,
       updated_at = now()`,
    [
      sessionId,
      version.provider,
      version.id,
      version.adapterVersion,
      version.contentHash,
      JSON.stringify(version.manifest),
      JSON.stringify(version.runtimeOverlay),
    ],
  );
  if (advanceSessionVersion) {
    await client.query(
      'UPDATE sessions SET agent_profile_version_id = $2 WHERE id = $1',
      [sessionId, version.id],
    );
  }
  await notifyProfileBundlesAdvanced(client, sessionId, version.provider);
}

async function notifyProfileBundlesAdvanced(
  client: Queryable,
  sessionId: string,
  provider: AgentProfileProvider,
): Promise<void> {
  await client.query("SELECT pg_notify('profile_bundles_advanced', $1)", [
    JSON.stringify({ sessionId, provider }),
  ]);
}

async function updateProposalStatus(
  client: Queryable,
  proposalId: string,
  userId: string,
  status: AgentProfileProposal['status'],
): Promise<AgentProfileProposal> {
  const row = await client.query<ProposalRow>(
    `UPDATE session_profile_change_proposals
     SET status = $3,
         resolved_by = $2,
         resolved_at = now(),
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [proposalId, userId, status],
  );
  const found = row.rows[0];
  if (!found) throw new DomainError(404, 'proposal_not_found', 'proposal not found');
  return proposalFromRow(found);
}

async function requirePendingProposal(
  client: Queryable,
  userId: string,
  proposalId: string,
): Promise<ProposalRow> {
  const row = await client.query<ProposalRow>(
    `SELECT * FROM session_profile_change_proposals
     WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [proposalId, userId],
  );
  const found = row.rows[0];
  if (!found) throw new DomainError(404, 'proposal_not_found', 'proposal not found');
  if (found.status !== 'pending') {
    throw new DomainError(409, 'proposal_not_pending', 'proposal is not pending');
  }
  return found;
}

async function requirePendingSessionProposal(
  client: Queryable,
  userId: string,
  sessionId: string,
  proposalId: string,
): Promise<ProposalRow> {
  await assertSessionReadable(client, sessionId, userId);
  const proposal = await requirePendingProposal(client, userId, proposalId);
  if (proposal.session_id !== sessionId) {
    throw new DomainError(404, 'proposal_not_found', 'proposal not found');
  }
  return proposal;
}

async function assertSessionReadable(pool: Queryable, sessionId: string, userId: string): Promise<void> {
  const row = await pool.query<{ channel_id: string }>(
    `SELECT channel_id
     FROM sessions
     WHERE id = $1`,
    [sessionId],
  );
  const channelId = row.rows[0]?.channel_id;
  if (!channelId || !(await canAccessChannel(pool, userId, channelId))) {
    throw new DomainError(404, 'session_not_found', 'session not found');
  }
}

async function requireProfile(
  client: Queryable,
  userId: string,
  profileId: string,
): Promise<ProfileRow> {
  const row = await client.query<ProfileRow>(
    `SELECT id, provider, name, current_version_id, created_at, updated_at
     FROM agent_profiles
     WHERE id = $1 AND user_id = $2
     FOR UPDATE`,
    [profileId, userId],
  );
  const found = row.rows[0];
  if (!found) throw new DomainError(404, 'profile_not_found', 'profile not found');
  return found;
}

async function insertProfile(
  client: Queryable,
  userId: string,
  provider: AgentProfileProvider,
  name: string,
): Promise<ProfileRow> {
  const row = await client.query<ProfileRow>(
    `INSERT INTO agent_profiles (user_id, provider, name)
     VALUES ($1, $2, $3)
     RETURNING id, provider, name, current_version_id, created_at, updated_at`,
    [userId, provider, name],
  );
  return row.rows[0]!;
}

async function profileIdFromBaseVersion(
  client: Queryable,
  userId: string,
  versionId: string | null,
): Promise<string | null> {
  if (!versionId) return null;
  const row = await client.query<{ profile_id: string }>(
    `SELECT v.profile_id
     FROM agent_profile_versions v
     JOIN agent_profiles p ON p.id = v.profile_id
     WHERE v.id = $1 AND p.user_id = $2`,
    [versionId, userId],
  );
  return row.rows[0]?.profile_id ?? null;
}

async function loadVersionForUser(
  client: Queryable,
  userId: string,
  versionId: string,
): Promise<AgentProfileVersion | null> {
  const row = await client.query<VersionRow>(
    `SELECT v.*
     FROM agent_profile_versions v
     JOIN agent_profiles p ON p.id = v.profile_id
     WHERE v.id = $1 AND p.user_id = $2`,
    [versionId, userId],
  );
  return row.rows[0] ? versionFromRow(row.rows[0]) : null;
}

function proposalFromRow(row: ProposalRow): AgentProfileProposal {
  return {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    baseProfileVersionId: row.base_profile_version_id,
    adapterVersion: row.adapter_version,
    proposal: row.proposal_json,
    diff: row.proposal_json.diff,
    riskSummary: row.risk_summary_json,
    status: row.status,
    source: row.source,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
}

function diffManifests(
  baseline: AgentProfileManifest | null,
  current: AgentProfileManifest,
): AgentProfileDiff {
  const currentPaths = manifestDiffPaths(current);
  if (!baseline) {
    return { added: [...currentPaths.keys()].sort(), changed: [], removed: [] };
  }
  const baselinePaths = manifestDiffPaths(baseline);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, value] of currentPaths) {
    if (!baselinePaths.has(path)) {
      added.push(path);
    } else if (stableStringify(baselinePaths.get(path)) !== stableStringify(value)) {
      changed.push(path);
    }
  }
  for (const path of baselinePaths.keys()) {
    if (!currentPaths.has(path)) removed.push(path);
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

function manifestDiffPaths(manifest: AgentProfileManifest): Map<string, unknown> {
  const paths = new Map<string, unknown>();
  collectDiffPaths(manifest.settings, ['settings'], paths);
  collectDiffPaths(manifest.mcpServers, ['mcpServers'], paths);
  return paths;
}

function collectDiffPaths(value: unknown, path: string[], out: Map<string, unknown>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      if (path.length > 1) out.set(path.join('.'), {});
      return;
    }
    for (const [key, child] of entries) collectDiffPaths(child, [...path, key], out);
    return;
  }
  if (path.length > 1) out.set(path.join('.'), value);
}

function profileFromRow(row: ProfileRow, version: AgentProfileVersion | null | undefined): AgentProfile {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    currentVersionId: row.current_version_id,
    currentVersion: version ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function versionFromRow(row: VersionRow): AgentProfileVersion {
  return {
    id: row.id,
    profileId: row.profile_id,
    provider: row.provider,
    adapterVersion: row.adapter_version,
    manifest: row.manifest_json,
    runtimeOverlay: row.runtime_overlay_json,
    contentHash: row.content_hash,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function sanitizeProfileObject(
  value: unknown,
  path: string[],
): {
  value: Record<string, unknown>;
  excluded: { key: string; reason: string }[];
  warnings: string[];
  blockedSecrets: number;
} {
  const sanitized = sanitizeValue(value, path);
  return {
    value: asRecord(sanitized.value),
    excluded: sanitized.excluded.map((item) => ({
      key: metadataKeyPath(item.key ?? item.path ?? path.join('.')),
      reason: item.reason,
    })),
    warnings: sanitized.warnings.map((warning) =>
      normalizeMetadataString(warning, 'profile metadata warning', 300),
    ),
    blockedSecrets: sanitized.blockedSecrets,
  };
}

function sanitizeValue(
  value: unknown,
  path: string[],
): {
  value: unknown;
  excluded: { key?: string; path?: string; reason: string }[];
  warnings: string[];
  blockedSecrets: number;
} {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return { value, excluded: [], warnings: [], blockedSecrets: 0 };
  }
  if (typeof value === 'string') {
    if (looksSecretValue(value)) {
      const key = metadataKeyPath(path.join('.'));
      return {
        value: undefined,
        excluded: [{ key, reason: 'secret_value' }],
        warnings: [`Blocked secret-shaped value at ${key}`],
        blockedSecrets: 1,
      };
    }
    return { value, excluded: [], warnings: [], blockedSecrets: 0 };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const excluded: { key?: string; path?: string; reason: string }[] = [];
    const warnings: string[] = [];
    let blockedSecrets = 0;
    value.slice(0, 256).forEach((item, index) => {
      const child = sanitizeValue(item, [...path, String(index)]);
      if (child.value !== undefined) out.push(child.value);
      excluded.push(...child.excluded);
      warnings.push(...child.warnings);
      blockedSecrets += child.blockedSecrets;
    });
    return { value: out, excluded, warnings, blockedSecrets };
  }
  if (typeof value !== 'object') {
    return { value: undefined, excluded: [], warnings: [], blockedSecrets: 0 };
  }

  const out: Record<string, unknown> = {};
  const excluded: { key?: string; path?: string; reason: string }[] = [];
  const warnings: string[] = [];
  let blockedSecrets = 0;
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (metadataKeyContainsSecret(key) && !isEnvVarNameKey(key, childValue)) {
      const redactedPath = metadataKeyPath(childPath.join('.'));
      excluded.push({ key: redactedPath, reason: 'secret_key' });
      warnings.push(`Blocked secret-shaped key ${redactedPath}`);
      blockedSecrets += 1;
      continue;
    }
    const child = sanitizeValue(childValue, childPath);
    if (child.value !== undefined) out[key] = child.value;
    excluded.push(...child.excluded);
    warnings.push(...child.warnings);
    blockedSecrets += child.blockedSecrets;
  }
  return { value: out, excluded, warnings, blockedSecrets };
}

function isEnvVarNameKey(key: string, value: unknown): boolean {
  return /env_var/i.test(key) && typeof value === 'string' && SAFE_ENV_VAR_RE.test(value);
}

function looksSecretValue(value: string): boolean {
  if (SECRET_VALUE_RE.test(value)) return true;
  // Pure-hex strings are content hashes / ids (sha256, sha1), not secrets — never
  // treat them as credential-shaped, or every artifact/bundle manifest (which carry
  // sha256 file hashes) would be wrongly rejected as containing a secret.
  if (/^[0-9a-f]+$/i.test(value)) return false;
  if (value.length >= 32 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) {
    if (/token|secret|key|auth/i.test(value)) return true;
    // The length>=48 catch-all targets opaque high-entropy tokens. File paths (which
    // contain '/') are not secrets — and bundle/harness-state manifests carry long
    // paths. Opaque tokens (incl. raw JWTs) have no '/', so they're still caught.
    return value.length >= 48 && !value.includes('/');
  }
  return false;
}

function normalizeBundles(
  value: unknown,
  excluded: { path?: string; key?: string; reason: string }[],
  warnings: string[],
): NonNullable<AgentProfileManifest['bundles']> {
  if (!Array.isArray(value)) return [];
  const bundles: NonNullable<AgentProfileManifest['bundles']> = [];
  for (const item of value.slice(0, 128)) {
    const row = asRecord(item);
    const path = normalizeProfilePath(row.path);
    if (!path) {
      excluded.push({ reason: 'invalid_bundle_path' });
      continue;
    }
    if (deniedProfilePath(path)) {
      excluded.push({ path, reason: 'denied_path' });
      continue;
    }
    const sizeBytes = Number(row.sizeBytes ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_BUNDLE_BYTES) {
      excluded.push({ path, reason: 'bundle_too_large' });
      continue;
    }
    const executable = row.executable === true || /\.(sh|bash|zsh|py|js|ts|mjs|cjs)$/.test(path);
    if (executable) warnings.push(`Executable profile bundle requires review: ${path}`);
    bundles.push({
      path,
      role: normalizeMetadataString(row.role, 'bundle', 40),
      sha256: normalizeSha(row.sha256),
      sizeBytes,
      ...(executable ? { executable: true } : {}),
      warnings: normalizeSafeStringArray(row.warnings, 16, 'bundle warning'),
    });
  }
  return bundles;
}

function normalizeExcluded(value: unknown): { path?: string; key?: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).map((item) => {
    const row = asRecord(item);
    const path = row.path ?? row.source_path;
    const key = row.key ?? row.key_path;
    return {
      ...(typeof path === 'string' ? { path: normalizeMetadataString(path, '[redacted-path]', 300) } : {}),
      ...(typeof key === 'string' ? { key: normalizeMetadataString(key, '[redacted-key]', 300) } : {}),
      reason: normalizeMetadataString(row.reason, 'excluded', 80),
    };
  });
}

function normalizeSourceHashes(value: unknown): AgentProfileProposalPayload['sourceHashes'] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((item) => {
    const row = asRecord(item);
    const path = normalizeProfilePath(row.path);
    if (!path || deniedProfilePath(path)) return [];
    return [{
      path,
      sha256: normalizeSha(row.sha256 ?? row.hash),
      ...(Number.isFinite(Number(row.sizeBytes ?? row.size_bytes))
        ? { sizeBytes: Number(row.sizeBytes ?? row.size_bytes) }
        : {}),
    }];
  });
}

function normalizeRiskLabels(value: unknown): AgentProfileRiskLabel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AgentProfileRiskLabel =>
    item === 'safe'
    || item === 'needs-secret-ref'
    || item === 'policy-capped'
    || item === 'unsupported',
  );
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 1_000_000) : 0;
}

function normalizeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeSafeStringArray(value: unknown, max: number, fallback: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeMetadataString(item, fallback, 300))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeShortString(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function normalizeMetadataString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) return fallback;
  return metadataStringContainsSecret(trimmed) ? fallback : trimmed;
}

function metadataKeyContainsSecret(value: string): boolean {
  return SECRET_KEY_RE.test(value) || metadataStringContainsSecret(value);
}

function metadataKeyPath(value: string): string {
  return value
    .split('.')
    .map((part) => (metadataKeyContainsSecret(part) ? '[redacted-key]' : part))
    .join('.');
}

function normalizeName(value: unknown, provider: AgentProfileProvider): string {
  return normalizeShortString(
    value,
    provider === CODEX_PROVIDER ? 'Codex profile' : 'Claude Code profile',
    80,
  );
}

function normalizeOptionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSha(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : sha256(String(value ?? ''));
}

function normalizeProfilePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  if (!path || path.includes('\0') || path.split('/').some((part) => part === '..')) return null;
  if (metadataStringContainsSecret(path)) return null;
  return path.slice(0, 300);
}

export function normalizeAgentProfilePath(value: unknown): string | null {
  return normalizeProfilePath(value);
}

export function isDeniedAgentProfilePath(path: string): boolean {
  return deniedProfilePath(path);
}

function assertNoDeniedProfilePaths(value: unknown): void {
  const denied = firstDeniedProfilePath(value);
  if (denied) {
    throw new DomainError(400, 'denied_profile_path', `profile baseline includes denied path: ${denied}`);
  }
}

function firstDeniedProfilePath(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const denied = firstDeniedProfilePath(item);
      if (denied) return denied;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // `excluded`/`sourceHashes` legitimately record the denied paths the producer
    // already filtered out — they are metadata, not active content. Only active
    // content (settings/mcpServers/bundles) could smuggle a denied path in, so skip
    // these branches or every correctly-sanitized baseline would be rejected.
    if (/^(excluded|source_?hashes|source_file_hashes|warnings)$/i.test(key)) continue;
    if (
      /^(path|source_path)$/i.test(key)
      && typeof child === 'string'
      && normalizeProfilePath(child)
      && deniedProfilePath(normalizeProfilePath(child)!)
    ) {
      return child;
    }
    const denied = firstDeniedProfilePath(child);
    if (denied) return denied;
  }
  return null;
}

function deniedProfilePath(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  return parts.some((part) => part === '.ssh' || part === '.aws' || part === '.git')
    || parts.some((part) => part.includes('credentials'))
    || ['auth.json', '.credentials.json', '.netrc', '.git-credentials'].includes(parts.at(-1) ?? '')
    || /\.(pem|key)$/.test(parts.at(-1) ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataStringContainsSecret(value: string): boolean {
  return looksSecretValue(value) || SECRET_VALUE_RE.test(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function toToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTomlTable(lines, [], value);
  return `${lines.join('\n').trim()}\n`;
}

function writeTomlTable(lines: string[], path: string[], table: Record<string, unknown>): void {
  const nested: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(table)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nested.push([key, value as Record<string, unknown>]);
    } else {
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
  }
  for (const [key, child] of nested) {
    if (lines.length > 0) lines.push('');
    const nextPath = [...path, key];
    lines.push(`[${nextPath.map(tomlKey).join('.')}]`);
    writeTomlTable(lines, nextPath, child);
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  return JSON.stringify(String(value ?? ''));
}
