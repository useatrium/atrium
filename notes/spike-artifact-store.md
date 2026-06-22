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

---

## Outcome (2026-06-19): **recommend Option B — extend our own CAS-ledger**

Both tracks were stood up and **run live** against the dev stack (Docker:
postgres `:5433` + MinIO `:9000` + lakeFS 1.82.0 with a Postgres KV and the
MinIO S3 blockstore). Every number and behavior below is from an actual
execution, not estimated. The prior lean held — and survived a real look at
lakeFS: lakeFS lost on **both** heavily-weighted dimensions (#1 conflict-fit,
#6 ops) while being a wash everywhere it was supposed to win.

### Scored rubric (1–5; **#1 and #6 weighted heaviest**)

| # | Dimension | **Own CAS-ledger** | **lakeFS (OSS)** | Evidence |
|---|-----------|:---:|:---:|----------|
| 1 | **Conflict/merge fit** ⚖️ | **5** | **2** | Own: first-class `status=conflict` version storing **both sides** jj-style (markers + `conflict` jsonb), resolve later — proven. lakeFS: whole-object only; conflicting merge → **HTTP 409 abort**, or `strategy=dest-wins` **silently discards** the loser's whole edit. No conflict-state. |
| 2 | Egress-only fit | 5 | 5 | Own pipeline already egress-only (Centaur→our S3). lakeFS S3-gateway + REST are purely outbound. |
| 3 | Pointers & lineage | **5** | 3 | Own: explicit `pointers` + `lineage` tables; stale-downstream join proven. lakeFS: great commit-DAG/branches/tags for *pointers*, but **cross-artifact provenance is not native** — you'd track lineage externally anyway. |
| 4 | Large binaries | 4 | 4 | Parity (see below); both bounded by local MinIO. lakeFS edge: native gateway multipart. Own edge: writes **direct to S3, no proxy hop** in prod. |
| 5 | Access control | **3** | 2 | Own: presigned-GET + Postgres row scoping; per-channel/tenant model is our SQL to write. lakeFS **OSS**: `/auth/policies`, `/auth/groups`, group ACLs **all 501 Not Implemented** — single-admin; prefix/tenant RBAC is Cloud/Enterprise. |
| 6 | **Operational burden** ⚖️ | **3** | **2** | Own: our migrations + GC + multipart, but **reuses** the existing lease worker + `s3.ts` + PG. lakeFS: net-new **server + dedicated KV DB**, and committed-GC is a **separate Spark job**. |
| 7 | Time-to-v1 | **4** | 3 | Own: ~900 LOC mostly-glue on existing scaffolding (built+run in one pass). lakeFS: versioning is free, but you still migrate the `session_artifacts` pipeline onto it, build lineage separately, **and** build conflict-state on top (or accept its merge semantics). |
| 8 | Notify/invalidation hookability | 5 | 5 | Own: LISTEN/NOTIFY or outbox on `pointers`/`artifact_versions` writes (trivial). lakeFS: Actions/webhooks fire a structured `post-commit` JSON to our event-log listener — **proven** (`run=completed`). |
| 9 | Search/query | **5** | 3 | Own: full SQL over versions/pointers/lineage incl. jsonb conflict payload. lakeFS: commit-log/diff/listing are good; arbitrary metadata facets (mime/size/tenant) need a side index — it's not a SQL store. |
| | **Raw total** | **39** | **29** | weighted gap is larger: on #1+#6 alone, **8 vs 4**. |

### The conflict-UX finding (the make-or-break)

This was the whole reason to spike rather than just pick. **lakeFS merge is
whole-object 3-way only.** Two branches edited the same line off a common base:
the first merge was clean (`HTTP 200`); the second returned **`HTTP 409` with an
empty `reference`** (the body doesn't even name the conflicting lines), aborting
the merge. The only resolution knobs are whole-object **`source-wins` /
`dest-wins` / fail** — running `dest-wins` kept main's version and **threw the
other agent's entire edit away**. There is no native way to record "both sides,
resolve later." To get jj-style conflict-state on lakeFS you would store
conflict-marker bytes as the object yourself and track conflict status
out-of-band — i.e. **rebuild the exact mechanism the own-track already has, on
top of a store that fought you.** The own-track, by contrast, recorded the
collision as a first-class `seq=3, status=conflict` version whose blob carries
`<<<<<<< LEFT / ||||||| BASE / ======= / >>>>>>> RIGHT` plus a `conflict` jsonb
with each side's label/author/sha — verified live. **This single finding is
decisive given #1's weight.**

### 500 MB parity check (whole-object, no CDC — both)

| | hash | upload | download | integrity |
|---|---|---|---|---|
| Own (32×16 MB multipart → MinIO) | 254 ms (1970 MB/s) | 5028 ms (**99 MB/s**) | 3389 ms (**148 MB/s**) | ✅ sha match |
| lakeFS (S3-gateway PutObject → MinIO) | 274 ms | 4531 ms (**110 MB/s**) | 3744 ms (**134 MB/s**) | ✅ sha match |

At parity. lakeFS's gateway multipart is marginally faster up; own is faster
down and, in prod, avoids lakeFS's extra proxy hop by writing straight to S3.
Large binaries are **not** a differentiator.

### Why not lakeFS, in one line

The part everyone assumes lakeFS saves — the version/Merkle/branch engine — is
the **cheap** part for us (~900 LOC, ~half reused). The parts we actually need —
**jj-style conflict-state** and **per-tenant/channel scoping** — are exactly
what OSS lakeFS *can't* give (whole-file merge; RBAC paywalled), so we'd build
them on top anyway, while also operating a new stateful server + KV + Spark GC.
Its one genuine strength (event hookability) we match trivially on Postgres.

### v1 build list for the chosen path (own CAS-ledger)

New code on top of the existing `session_artifacts` capture pipeline (TS + SQL):

| Component | LOC |
|---|---|
| Schema migration (version chain, pointers, lineage, conflict cols/checks/indexes) | 60–100 |
| Version-chain + pointer-advance write path (commit-by-hash, dedup via HeadObject, base_seq) | 90–140 |
| **Write-back PUT endpoint** (client upload → hash → version → pointer; pipeline is capture-only today) | 100–160 |
| Read-by-pointer serve route (resolve latest/official/pin → presigned redirect; extends `getArtifactServePlan`) | 50–80 |
| **Conflict-state + 3-way merge** (robust diff3 — pull a lib, don't ship the hand-rolled one; record both-sides version) | 120–180 |
| Lineage edges + stale-downstream query/API | 50–90 |
| Multipart upload helper (no `lib-storage` in tree today) | 60–100 |
| GC (unreferenced-blob sweep; clone the lease worker) | 80–130 |
| Wiring / types / tests | 80–140 |
| **Total** | **~690–1120 (~900 midpoint)** |

**Already built & reusable** (shrinks the above): `src/s3.ts`
(`uploadObject`/`presignGet`/`presignPut`/`deleteObject`, used as-is), sha256
capture in `recordArtifact`, the **claim-then-release lease worker**
(`offloadArtifactBatch`/`artifact-offload.ts`) which GC clones almost verbatim,
and the presigned-redirect path in `getArtifactServePlan`. The net-new surface
is the ledger tables + write-back + conflict-state.

### Scope notes / not blockers

- **CDC/chunk-dedup stays deferred** (both candidates do whole-object; own does
  sha256 whole-object dedup — proven by the skipped re-PUT). Revisit only if
  near-dup large binaries dominate storage cost.
- The **glue is identical either way** (capture daemon, no-ingress invalidation,
  promotion policy) — it does not move the decision.
- Caveat carried from `agent-data-architecture.md`: **mid-session inbound sync**
  (pulling edits back into a *running* no-ingress sandbox) is separate, new
  Centaur work and is not affected by this choice.
- The v1 conflict merge must swap the spike's hand-rolled line-diff3 for a
  battle-tested diff3 lib (the spike's first pass had a replace-line bug).

**Decision: build Option B (extend own CAS-ledger).** Lean confirmed, not
falsified; lakeFS got its real look and lost on the weighted axes.
