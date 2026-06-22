# H10 — Atomic multi-file commit-group / tree-manifest contract (FOUNDATION)

> Locked by the orchestrator (2026-06-21). Both halves — Atrium ledger (codex lane)
> and Centaur hydrate (Claude-direct lane) — implement THESE semantics. Closes §8B #13.

## Decision: STRICT all-or-nothing
A commit-group is a coherent multi-file change (e.g. a refactor touching 3 files). It
lands as ONE atomic unit or not at all — a reader never observes a half-applied group.
This OVERRIDES any "per-file partial success" reading: partial success is NOT atomic and
defeats the purpose of #13. A stale file rejects the **whole** group; the producer
rebases the whole manifest and resubmits (like a git commit). The atomic group path is
OCC-strict (reject-and-rebase); it does NOT mint diff3 conflict-state — that stays on the
single-file capture/write-back path.

## Wire format (Centaur node → Atrium)
Bytes are uploaded out-of-band first (existing capture/raw path, or H8 streaming) so the
commit-group is a **pure metadata** atomic operation over already-present CAS blobs. The
group endpoint references blob shas that already exist in `cas_blobs` + S3.

```
POST /api/internal/sessions/:id/artifacts/commit-group
Auth: x-api-key  (requireCaptureKey — same as single-file capture)
Content-Type: application/json
Body: {
  group_id: string,            // idempotency key = Centaur checkpoint/execution id
  files: [{                     // 1..N
    path: string,               // workspace-relative; no ".." ; validated like capture
    blob_sha: string | null,    // null IFF kind="deleted"
    size_bytes: number,
    mime: string,
    base_seq: number | null,    // OCC base the producer edited against; null = first/implicit
    kind: "created" | "modified" | "deleted",
    merge_class?: "immutable-data" | "mergeable-doc" | "derived-output"  // first-create only
  }]
}
```

## Semantics (one DB transaction — `withTx`)
1. **Idempotency.** `group_id` recorded in `artifact_commit_groups` (mig 037). If a row with
   a committed `result` already exists → return that cached result verbatim (never double-
   apply). The group row is inserted IN the same txn, so ROLLBACK removes it too.
2. **OCC precheck (all-or-nothing).** For each file, `effectiveBase = base_seq ?? latest.seq`.
   If ANY file has `base_seq != latest.seq` (stale) → **abort the whole group** (ROLLBACK):
   `409 { ok:false, reason:"stale_base", stale:[{path, latest_seq, base_seq}, ...] }`.
   No version inserted, no pointer moved, no change-feed row. The producer rebases all and
   resubmits with the same `group_id`.
3. **Apply (all current).** In the same txn: `upsertBlob` each unique sha, `insertVersion`
   for each file (`seq = latest.seq + 1`, or 1 for first), `advancePointer('latest')` for
   each. The existing change-feed + blob_refs triggers fire N times inside the txn (gap-free
   by xid+id). Persist the group result, COMMIT.
4. **Per-file content dedup.** If `blob_sha == latest.blob_sha` and not deleted, that file is
   a no-op (returns its existing seq) but is still part of the atomic group (does not abort).
5. **Response (success):** `200 { ok:true, group_id, results:[{path, seq}, ...] }`.

## Change-feed linkage (mig 037 also adds `group_id` to `artifact_changes`)
Each change-feed row emitted by a commit-group carries the `group_id` (nullable; null for
single-file writes). This is the ONLY way the Centaur hydrate side can re-group inbound rows
into the same atomic manifest. Single-file writes leave it null and behave exactly as today.

## Migration 037 (Atrium)  — `037_artifact_commit_groups.sql`
```sql
CREATE TABLE IF NOT EXISTS artifact_commit_groups (
  group_id     text PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  result       jsonb,            -- null until committed; then {ok, results:[...]}
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_commit_groups_session_idx
  ON artifact_commit_groups (session_id, created_at DESC);

ALTER TABLE artifact_changes ADD COLUMN IF NOT EXISTS group_id text;  -- nullable; set by commit-group
```

## Centaur hydrate side (inbound adopt — mirror of strict semantics)
- The daemon groups inbound `artifact_changes` rows sharing a non-null `group_id` into one
  `TreeManifest { id: group_id, entries: [{path, seq, sha, bytes}] }`.
- `apply_manifest_atomic`: (1) decide each entry via the existing 3-case adopter; if ANY
  entry must `ReconcileViaWriteback` or `SurfaceConflict`, DO NOT apply the group — defer the
  whole manifest (the writeback/conflict path handles those files individually, then the
  group reconciles on a later sweep). (2) quiesce-gate ALL entry paths; if ANY is busy, defer
  the WHOLE manifest. (3) stage all to temp, then rename all (or none) — a `.commit` marker
  makes a crash mid-apply recoverable (re-scan + retry). (4) `sync_manifests` advances ALL
  entries' base_seq/applied_remote_seq atomically (one state write), with
  `last_applied_group_id` for idempotent resume.
- Single-file changes (group_id null) keep the existing per-path adopt path unchanged.

## Test gates
- Atrium: commitVersionGroup — happy N-file commit; one stale file aborts the whole group
  (0 versions land); idempotent replay by group_id; per-file dedup inside a group; change-feed
  emits N rows all carrying group_id, gap-free. (mirror artifactLedger.test.ts harness)
- Centaur: apply_manifest_atomic — all-land; one busy path defers the whole manifest (0
  writes); one reconcile-needed entry defers the group; sync_manifests advances all-or-none;
  idempotent resume via last_applied_group_id. (mirror quiesce.rs / runtime.rs tests)
