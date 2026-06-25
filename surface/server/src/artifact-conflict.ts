// Assemble the both-sides conflict payload the resolution UI renders. Reads the
// `status=conflict` version's jsonb (recorded by the write-back / capture lanes)
// and hydrates the text of base/left/right from the CAS so the client can show a
// real diff. Handles all three conflict kinds: diff3 content conflicts and the
// two delete-vs-edit shapes (Gary's "never auto-pick" decision, §8B #5 / #5-del).

import { ArtifactLedger, casBlobKey } from './artifact-ledger.js';
import type { Db } from './db.js';

export interface ConflictStorage {
  getObjectBytes(key: string): Promise<Buffer>;
}

export interface ConflictSideOut {
  label: string;
  author: string;
  sha: string | null;
  text: string;
}

export interface ArtifactConflictOut {
  artifactId: string;
  path: string;
  kind: string;
  conflictSeq: number;
  baseSeq: number | null;
  base: { sha: string | null; text: string };
  left: ConflictSideOut;
  right: ConflictSideOut;
  markers: string;
}

interface DiffSide {
  seq?: number;
  author?: string;
  sha?: string | null;
}
interface ConflictPayload {
  kind?: string;
  base_seq?: number | null;
  left?: DiffSide;
  right?: DiffSide;
  deleted?: DiffSide;
  edited?: DiffSide;
}

export async function loadConflictDetail(
  pool: Db,
  storage: ConflictStorage,
  sessionId: string,
  path: string,
  options: { readableChannelIds?: readonly string[] } = {},
): Promise<ArtifactConflictOut | null> {
  const ledger = new ArtifactLedger(pool);
  const conflict = await ledger.getConflict(sessionId, path, options);
  if (!conflict) return null;
  const payload = (conflict.conflict ?? {}) as ConflictPayload;

  const blobText = async (sha: string | null | undefined): Promise<string> => {
    if (!sha) return '';
    const key = (await ledger.blobS3Key(sha)) ?? casBlobKey(sha);
    try {
      return (await storage.getObjectBytes(key)).toString('utf8');
    } catch {
      return '';
    }
  };

  const baseSeq = payload.base_seq ?? null;
  let baseSha: string | null = null;
  if (baseSeq != null) {
    const baseVer = await ledger.resolveVersion(sessionId, path, { seq: baseSeq }, options);
    baseSha = baseVer?.blobSha ?? null;
  }
  const markers = await blobText(conflict.markerSha);

  let left: ConflictSideOut;
  let right: ConflictSideOut;

  if (payload.kind === 'delete_vs_edit') {
    left = { label: 'deleted', author: payload.deleted?.author ?? 'unknown', sha: null, text: '' };
    right = {
      label: `edit (${payload.edited?.author ?? 'unknown'})`,
      author: payload.edited?.author ?? 'unknown',
      sha: payload.edited?.sha ?? null,
      text: await blobText(payload.edited?.sha),
    };
  } else if (payload.kind === 'edit_vs_delete') {
    left = {
      label: `edit (${payload.edited?.author ?? 'unknown'})`,
      author: payload.edited?.author ?? 'unknown',
      sha: payload.edited?.sha ?? null,
      text: await blobText(payload.edited?.sha),
    };
    right = { label: 'deleted', author: payload.deleted?.author ?? 'unknown', sha: null, text: '' };
  } else {
    // diff3 content conflict
    left = {
      label: payload.left?.seq != null ? `v${payload.left.seq} (${payload.left.author ?? '?'})` : 'theirs',
      author: payload.left?.author ?? 'unknown',
      sha: payload.left?.sha ?? null,
      text: await blobText(payload.left?.sha),
    };
    right = {
      label: `incoming (${payload.right?.author ?? '?'})`,
      author: payload.right?.author ?? 'unknown',
      sha: payload.right?.sha ?? null,
      text: await blobText(payload.right?.sha),
    };
  }

  return {
    artifactId: conflict.artifactId,
    path,
    kind: payload.kind ?? 'diff3',
    conflictSeq: conflict.conflictSeq,
    baseSeq,
    base: { sha: baseSha, text: await blobText(baseSha) },
    left,
    right,
    markers,
  };
}
