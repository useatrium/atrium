# WIP snapshot retention plan

Status: scoped from current `master` on 2026-06-25. This covers session-scoped
scratch/WIP artifact history, not shared project/channel files.

## Problem

The current artifact GC is a CAS reachability sweep:

- `artifact-ledger-gc.ts` deletes only `cas_blobs` with no row in
  `artifact_blob_refs`.
- `artifact_blob_refs` is populated by artifact versions and conflict payloads.
- Therefore every normal scratch/WIP version keeps its blob alive forever.

That is correct for data integrity, but without a retention policy it means:

- long-running sessions can accumulate many WIP patch/scratch versions;
- dead sessions retain private working data indefinitely;
- storage growth is invisible because blob GC appears to run successfully but
  cannot collect referenced WIP blobs.

## Desired product behavior

Use a 30-day default history for session-scoped WIP/scratch artifacts.

Retention applies to:

- `scratch/<session-id>/...`
- repo WIP patch artifacts if they are stored under that session scratch
- superseded versions of those paths

Retention does not apply to:

- `shared/global/...`
- `shared/channels/...`
- future `shared/projects/...`
- app-pinned versions
- unresolved conflict refs
- versions explicitly pinned by a user, message attachment, app publish, or future
  "keep" action

The latest normal version of every live path should remain even if older than 30
days unless the whole session is explicitly archived/deleted under a stronger
policy.

## Data model

Add a retention root model rather than overloading CAS GC:

- `artifact_retention_policies`
  - `workspace_id`
  - `scope_prefix` such as `scratch/` or `scratch/<session-id>/`
  - `retention_days`
  - `mode` such as `prune_old_versions`
  - timestamps
- Optional later: `artifact_version_pins`
  - `artifact_id`, `seq`, `reason`, `owner_user_id`, `expires_at`

For v1, a config default can be enough:

- `ARTIFACT_SCRATCH_RETENTION_DAYS=30`
- `ARTIFACT_RETENTION_BATCH_SIZE`
- `ARTIFACT_RETENTION_INTERVAL_MS`

## Algorithm

Run a retention worker before CAS blob GC.

1. Select candidate artifact versions where:
   - artifact path starts with `scratch/`;
   - version `created_at < now() - interval '30 days'`;
   - version is not the latest normal pointer for that artifact;
   - version status is not `conflict`;
   - version is not referenced by an unresolved conflict payload;
   - version is not pinned by app/message/manual keep.
2. Delete or tombstone only the `artifact_versions` rows selected.
3. Let existing `artifact_blob_refs` triggers/backfill remove reachability.
4. Let `sweepUnreferencedBlobs` reclaim now-unreferenced `cas_blobs`.

Prefer tombstoning first if audit/history visibility matters:

- Add `artifact_versions.retained_until` and `pruned_at`, or a side table
  recording pruned refs.
- The API can report "pruned by retention" instead of pretending the version
  never existed.

## Conflict handling

Retention must not delete any sha that is still required to resolve a conflict.
Use `artifact_blob_refs` as the authoritative graph:

- if a candidate version's blob has any non-candidate ref, keep it;
- if a conflict version references old left/right/base shas, keep all of them;
- delete-vs-edit conflicts remain intact until resolved or explicitly discarded.

## Multi-agent repo WIP behavior

Two agents working in the same git repo in different containers should have
different WIP artifacts because WIP is session-scoped:

- Agent A: `scratch/<session-a>/repos/org/repo.wip.patch`
- Agent B: `scratch/<session-b>/repos/org/repo.wip.patch`

Hydration restores only the requesting session's scratch. Another session can see
the shared repo state through git and shared artifacts, but not another agent's
private WIP unless a human promotes/copies it into `shared/...`.

Gitignored build artifacts should stay out of WIP unless deliberately captured
as artifacts. WIP is for uncommitted source/worktree changes, not cache folders,
`node_modules`, build outputs, or dependency caches.

## API and UX

Server:

- Add a session/workspace retention summary route:
  - total scratch bytes
  - prunable bytes
  - oldest retained version
  - next scheduled sweep
- Add explicit "pin/keep" and "delete scratch" actions later.

Human UI:

- Surface scratch as session-private durable files.
- Show "kept for 30 days" on old scratch/WIP history.
- Allow manual cleanup of a session's scratch.

Agent UX:

- No prompt burden. The agent writes to `~/scratch` for private durable work or
  cwd/`shared/...` for shared work.
- Retention is a platform policy; the agent should not have to reason about GC.

## Tests

Server tests:

- keeps latest normal scratch version older than 30 days;
- prunes superseded old scratch versions;
- does not prune shared paths;
- does not prune conflict refs;
- does not prune app/message/manual pins;
- CAS GC reclaims blobs only after retention removes the final ref;
- two sessions with same repo path keep independent WIP histories.

Operational tests:

- dry-run mode reports candidates without deleting;
- batch worker is idempotent and resumes after partial failure;
- metrics for scanned, pruned, skipped, bytes freed, and failures.

