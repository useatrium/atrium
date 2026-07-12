// Harness-resume (rollout-JSONL project): durable per-session harness transcript
// store. The node-sync daemon captures the harness CLI's own session transcript
// (Claude `~/.claude/projects/.../<id>.jsonl`, Codex `rollout-<id>.jsonl`) each
// turn; on a cold-start resume a fresh sandbox fetches it back and writes it to
// the deterministic path so `--resume <id>` / `thread/resume` recalls the
// conversation. Internal harness state is NOT a user artifact, so it bypasses the
// ledger. Last-write-wins (every capture is a full snapshot).

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { containsProfileSecret } from './agent-profiles.js';

/** Harnesses we capture transcripts for (the resume path is per-harness). */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

interface BlobStorage {
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  getObjectBytes: (key: string) => Promise<Buffer>;
}

function transcriptKey(sessionId: string, harness: Harness): string {
  return `harness/${sessionId}/${harness}.jsonl`;
}

function bundleKey(sessionId: string, harness: Harness): string {
  return `harness/${sessionId}/${harness}.bundle.json`;
}

/** Store a full transcript snapshot (last-write-wins). Returns its size + sha. */
export async function storeHarnessTranscript(
  pool: Pool,
  storage: Pick<BlobStorage, 'uploadObject'>,
  sessionId: string,
  harness: Harness,
  bytes: Buffer,
): Promise<{ size: number; sha256: string }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = transcriptKey(sessionId, harness);
  await storage.uploadObject(key, bytes, 'application/x-ndjson');
  await pool.query(
    `INSERT INTO harness_transcripts (session_id, harness, s3_key, size_bytes, sha256, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (session_id, harness)
       DO UPDATE SET s3_key = EXCLUDED.s3_key, size_bytes = EXCLUDED.size_bytes,
                     sha256 = EXCLUDED.sha256, updated_at = now()`,
    [sessionId, harness, key, bytes.length, sha256],
  );
  return { size: bytes.length, sha256 };
}

/** Load the latest transcript snapshot, or null if none captured yet. */
export async function loadHarnessTranscript(
  pool: Pool,
  storage: Pick<BlobStorage, 'getObjectBytes'>,
  sessionId: string,
  harness: Harness,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const row = await pool.query<{ s3_key: string; sha256: string }>(
    `SELECT s3_key, sha256 FROM harness_transcripts WHERE session_id = $1 AND harness = $2`,
    [sessionId, harness],
  );
  const found = row.rows[0];
  if (!found) return null;
  const bytes = await storage.getObjectBytes(found.s3_key);
  return { bytes, sha256: found.sha256 };
}

export interface HarnessStateBundleInput {
  adapterVersion?: string;
  manifest?: unknown;
}

export interface HarnessStateBundleJson {
  harness: Harness;
  adapterVersion: string;
  manifest: unknown;
  sizeBytes: number;
  sha256: string;
  updatedAt: string;
}

export async function storeHarnessStateBundle(
  pool: Pool,
  storage: Pick<BlobStorage, 'uploadObject'>,
  sessionId: string,
  harness: Harness,
  input: HarnessStateBundleInput,
): Promise<{ size: number; sha256: string }> {
  const adapterVersion =
    typeof input.adapterVersion === 'string' && input.adapterVersion.trim()
      ? input.adapterVersion.trim().slice(0, 80)
      : 'atrium-v0';
  const manifest = input.manifest ?? {};
  if (containsProfileSecret(manifest) || containsDeniedHarnessPath(manifest)) {
    throw new Error('harness-state bundle contains credential-shaped data');
  }
  const bytes = Buffer.from(JSON.stringify({ harness, adapterVersion, manifest }) + '\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = bundleKey(sessionId, harness);
  await storage.uploadObject(key, bytes, 'application/json');
  await pool.query(
    `INSERT INTO harness_state_bundles (
       session_id, harness, adapter_version, manifest_json, s3_key, size_bytes, sha256, updated_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now())
     ON CONFLICT (session_id, harness)
       DO UPDATE SET adapter_version = EXCLUDED.adapter_version,
                     manifest_json = EXCLUDED.manifest_json,
                     s3_key = EXCLUDED.s3_key,
                     size_bytes = EXCLUDED.size_bytes,
                     sha256 = EXCLUDED.sha256,
                     updated_at = now()`,
    [sessionId, harness, adapterVersion, JSON.stringify(manifest), key, bytes.length, sha256],
  );
  return { size: bytes.length, sha256 };
}

export async function loadHarnessStateBundle(
  pool: Pool,
  sessionId: string,
  harness: Harness,
): Promise<HarnessStateBundleJson | null> {
  const row = await pool.query<{
    adapter_version: string;
    manifest_json: unknown;
    size_bytes: number;
    sha256: string;
    updated_at: Date;
  }>(
    `SELECT adapter_version, manifest_json, size_bytes, sha256, updated_at
     FROM harness_state_bundles
     WHERE session_id = $1 AND harness = $2`,
    [sessionId, harness],
  );
  const found = row.rows[0];
  if (!found) return null;
  return {
    harness,
    adapterVersion: found.adapter_version,
    manifest: found.manifest_json,
    sizeBytes: Number(found.size_bytes),
    sha256: found.sha256,
    updatedAt: new Date(found.updated_at).toISOString(),
  };
}

function containsDeniedHarnessPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDeniedHarnessPath);
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/path/i.test(key) && typeof child === 'string' && deniedHarnessPath(child)) {
      return true;
    }
    if (containsDeniedHarnessPath(child)) return true;
  }
  return false;
}

function deniedHarnessPath(value: string): boolean {
  const parts = value.replaceAll('\\', '/').toLowerCase().split('/');
  return (
    parts.some((part) => part === '.ssh' || part === '.aws' || part === '.git') ||
    parts.some((part) => part.includes('credentials')) ||
    ['auth.json', '.credentials.json', '.netrc', '.git-credentials'].includes(parts.at(-1) ?? '') ||
    /\.(pem|key)$/.test(parts.at(-1) ?? '')
  );
}
