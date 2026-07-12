import { createHash } from 'node:crypto';
import type { AgentProfileManifest, AgentProfileProvider } from '@atrium/surface-client/agentProfiles';
import type { Db } from './db.js';
import { loadCasBlob, persistCasBlob, type CasStorage } from './cas-storage.js';
import { isDeniedAgentProfilePath, normalizeAgentProfilePath } from './agent-profiles.js';
import { DomainError } from './events.js';

export const MAX_PROFILE_BUNDLE_BLOB_BYTES = 256 * 1024;

export interface ProfileBundleRef {
  path: string;
  sha256: string;
  role: string;
  executable: boolean;
}

export async function storeProfileBundleBlob(
  pool: Db,
  storage: Pick<CasStorage, 'uploadObject' | 'headObject'>,
  args: { sha256: string; path: string; bytes: Buffer },
): Promise<{ sha256: string; size_bytes: number }> {
  const sha256 = normalizeBundleSha(args.sha256);
  const path = normalizeAgentProfilePath(args.path);
  if (!path) throw new DomainError(400, 'bad_query', 'valid path is required');
  if (isDeniedAgentProfilePath(path)) {
    throw new DomainError(400, 'denied_profile_path', 'profile bundle path is denied');
  }
  if (args.bytes.length > MAX_PROFILE_BUNDLE_BLOB_BYTES) {
    throw new DomainError(413, 'profile_bundle_too_large', 'profile bundle blob is too large');
  }
  const actualSha = createHash('sha256').update(args.bytes).digest('hex');
  if (actualSha !== sha256) {
    throw new DomainError(400, 'sha256_mismatch', 'sha256 does not match body');
  }

  const key = profileBundleCasKey(sha256);
  await persistCasBlob(pool, storage, { sha256, key, bytes: args.bytes });

  return { sha256, size_bytes: args.bytes.length };
}

export async function loadProfileBundleBlob(
  pool: Db,
  storage: Pick<CasStorage, 'getObjectBytes'>,
  sha256: string,
): Promise<Buffer | null> {
  const normalized = normalizeBundleSha(sha256);
  return loadCasBlob(pool, storage, normalized);
}

export async function listSessionProfileBundles(
  pool: Db,
  sessionId: string,
  provider: AgentProfileProvider,
): Promise<ProfileBundleRef[]> {
  const row = await pool.query<{ manifest_json: AgentProfileManifest }>(
    `WITH bound AS (
       SELECT COALESCE(sps.profile_version_id, s.agent_profile_version_id) AS version_id
       FROM sessions s
       LEFT JOIN session_profile_snapshots sps
         ON sps.session_id = s.id AND sps.provider = $2
       WHERE s.id = $1
     )
     SELECT v.manifest_json
       FROM bound b
       JOIN agent_profile_versions v ON v.id = b.version_id AND v.provider = $2
      LIMIT 1`,
    [sessionId, provider],
  );
  const manifest = row.rows[0]?.manifest_json;
  if (!manifest?.bundles) return [];
  return manifest.bundles.map((bundle) => ({
    path: bundle.path,
    sha256: bundle.sha256,
    role: bundle.role,
    executable: bundle.executable === true,
  }));
}

export function normalizeBundleSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new DomainError(400, 'bad_query', 'valid sha256 is required');
  }
  return value.toLowerCase();
}

function profileBundleCasKey(sha256: string): string {
  return `cas/${sha256}`;
}
