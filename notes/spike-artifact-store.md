# Spike: Durable Artifact Store — lakeFS vs. own CAS-ledger

Timeboxed evaluation (target ~2–3 days) to decide what backs the durable,
cross-container artifact store. Feeds `agent-data-architecture.md`.

## The decision

The durable store must be: content-addressed + versioned, with **pointers**
(`latest`/`official`/pins), **branch + jj-style conflict-state** handling,
**egress-only** access from no-ingress sandboxes, cross-artifact **lineage/
provenance**, **access control** scoped to channels/tenants, **large binaries**
(whole-object/multipart is fine for v1), and **GC/retention**. Two candidates:

- **A. Adopt lakeFS** as the store (git-semantics over S3, API/S3-gateway).
- **B. Extend our own CAS-ledger** (Postgres + S3) — note this is **partly built
  already**: `session_artifacts` (mig 031/032), the S3 offload worker
  (`artifact-offload.ts`), and the presigned serve route exist on master.

**Explicitly OUT of scope for v1 (defer, may need later):** content-defined
chunking / chunk-dedup (CDC/Xet) — neither candidate does it now; whole-object
storage is acceptable for v1. Also out of scope (built either way / separate):
the in-container capture daemon, the no-ingress invalidation channel, live-doc
CRDT, and structured-DB branching.

## Why the spike (not just pick)

lakeFS could save the Merkle/branch/merge engine; but it has known gaps —
**whole-file-only merges with no per-object resolution** (may not give the
jj-style conflict-state we want), **no CDC** (deferred, so OK for v1), and it's
**another server + KV to operate**. The "own" side has a running head start and
total control over conflict-state + reuses Atrium's existing Postgres + S3, but is
more to build. The spike resolves which is less total work for a v1 that fits.

## Evaluation dimensions (rubric)

Score each candidate 1–5:
1. **Conflict/merge fit** — can it give jj-style *conflict-state* versions (both
   sides recorded, resolve later)? (lakeFS risk: fail/source-wins/dest-wins only.)
2. **Egress-only / no-ingress fit** — sandbox interacts purely outbound.
3. **Pointers & lineage** — `latest`/`official`/pins; cross-artifact provenance DAG.
4. **Large binaries** — multipart, few-hundred-MB to GB objects, no CDC.
5. **Access control** — channel/tenant scoping.
6. **Operational burden** — new infra to run vs. reuse Atrium Postgres + S3/MinIO.
7. **Time-to-v1** — incl. migrating the existing `session_artifacts` pipeline.
8. **Notify/invalidation hookability** — can changes feed our event log (the glue
   we build) cleanly? (lakeFS webhooks push out — usable to fan into the event log.)
9. **Search/query** — metadata filter + history.

## Tasks

**lakeFS track:**
1. Stand up lakeFS against the dev MinIO + its KV (Postgres). Note setup effort.
2. Repo + branches; commit an artifact; edit → new version; read by version/pointer.
3. Branch + concurrent edit + **merge a conflict** — assess the conflict UX vs.
   "jj-style conflict-state" (this is the make-or-break test).
4. Egress-only access from a sandbox-like client (S3-gateway/API outbound only).
5. Large binary (~500 MB) via multipart; measure commit/read latency.
6. RBAC scoping to a tenant/channel; GC config; webhook → event-log fan-in PoC.

**Own-CAS-ledger track:**
1. Minimal schema on existing Postgres: `artifacts(name) / artifact_versions(seq,
   sha, base, author, status) / pointers(latest/official) / lineage(edge)`; blobs
   by sha256 in MinIO (extend `session_artifacts`).
2. PUT blob by hash + version chain + pointer advance + read by version/pointer.
3. **Conflict-state on a text artifact**: 3-way vs base, record both sides as a
   conflict-state version (exact jj-style control — the point of building it).
4. Lineage edge + a "what's stale downstream" query.
5. Large binary (~500 MB) multipart; latency parity check.
6. Estimate remaining LOC/effort to v1 parity from the *current* pipeline.

## Decision criteria

Pick the lower-total-effort path **to a v1 that fits the constraints**, weighting
**#1 (conflict fit)** and **#6 (ops burden)** heavily. Prior lean (to be
falsified): the *own* side is favored — jj-style conflict-state needs per-object
control lakeFS doesn't give, it reuses infra we already run, and the pipeline is
partly built — but lakeFS gets a real look because the versioning engine is the
expensive part and CDC being deferred removes its worst drawback. Either way the
glue (daemon, no-ingress notify, promotion policy) is identical.

## Deliverable

A one-page recommendation (chosen backing + why, scored rubric, the conflict-UX
finding, and the v1 build list for the chosen path) appended here.
