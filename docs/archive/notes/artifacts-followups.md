# Artifacts — follow-up plan

Status of the sandbox artifact-capture feature after the 2026-06-18 build-out,
the B1 offload proof, and the 2026-06-25 hard cut. The original pipeline
(sandbox worker → api-rs capture routes → Postgres staging → `artifact.captured`
event → byte serve) is **historical proof**, not the current storage path.

> **UPDATE 2026-06-25:** B1 is now historical scaffolding, not the target storage
> shape. The replacement is **B2 — single-CAS hard cut**: fresh artifact
> capture writes durable Atrium CAS/S3 bytes before any non-delete ledger version
> commits, and `session_artifacts`/artifact-offload/Centaur proxy fallback are
> deleted rather than kept as a second mechanism. See `cas-ledger-build-plan.md`
> §3b-§3d and `shared-workspace-build-spec.md` lane F.

## Resolved
- **Centaur producer** (api-rs routes + sandbox `artifact_capture.py` worker +
  downward-API runtime-context) — on `fork/gb/api-rs-artifact-capture`, hardened
  (dedicated key, size cap, sha256 verify, nosniff/attachment), merged into the
  `atrium/integration` deploy line.
- **Atrium serve route** `GET /api/sessions/:id/artifacts/:artifactId` (A3b
  Phase 1) — proxies bytes from Centaur; on Atrium `master`. Dev key wired
  (`surface/deploy/.env` + compose + `.env.example`).
- **Fork migration numbering** — fork-permanent migrations use the reserved
  `1000+` range (paradigm uses sequential 4-digit). `artifact_blobs` is
  `1000_artifact_blobs.sql`. Codified in `ATRIUM_FORK.md`.
- **Adoption-test isolation** + integration `rerere` resolutions.

## Open follow-ups

### A1 — Proper sandbox→api-rs egress NetworkPolicy ✅ DONE (2026-06-18)
Chart template `sandbox-egress-api-rs.yaml` (gated on `apiRs.ironProxy.mode ==
disabled`, `managed-by:api-rs → api-rs:port`) on `gb/api-rs-artifact-capture`
(`c5d94d6`), integrated. Migration renumbered to `1000_artifact_blobs`; `ai_v2`
reconciled; new api-rs image deployed + re-migrated clean (`20=readonly_only`,
`21=etl`, `1000=artifact_blobs`). Chart policy applied live, manual band-aid
retired, smoke test re-passed through it (15× 200, 0 timeouts, artifact stored).
`infra/sandbox-egress-api-rs.yaml` is now redundant (kept as a reference). D1's
Centaur side re-verified here; the Atrium-route live check still needs the
surface server up.

<details><summary>original scope</summary>

Replace the manual `infra/sandbox-egress-api-rs.yaml` band-aid. With iron-proxy
disabled (local), no per-sandbox egress policy is created and the static ones
key on the legacy `centaur.ai/managed: "true"` label (api-rs sandboxes are
`centaur.ai/managed-by: api-rs`), so `default-deny` blocks the worker's POST.
- **Fix:** chart `NetworkPolicy` template allowing `managed-by: api-rs` →
  `api-rs:8080`, gated on iron-proxy disabled. On `gb/api-rs-artifact-capture`.
- **Also (this deploy):** reconcile the live cluster's `ai_v2`
  `_sqlx_migrations` — it has the *old* `0020 = artifact_blobs` recorded; with
  `0020` now paradigm's `readonly_role_only` and ours at `1000`, `run_migrations`
  will `VersionMismatch` on the next deploy unless the stale row + table are
  dropped so it re-applies clean.
- **Verify:** redeploy + re-run the live smoke test *without* the manual
  manifest. (Folds in D1.)
- **Effort:** S.
</details>

### A2 — Per-artifact `execution_id` on the wire ✅ DONE (2026-06-18)
Centaur adds `"execution_id"` to the `artifact.captured` payload
(`gb/api-rs-artifact-capture` `060eb59`, integrated); Atrium reducer keeps
`executionId` on `Artifact` and the serve route fetches from it, falling back to
`current_execution_id` for pre-`execution_id` events (Atrium `master` `ea9fc49`).
Unit-verified both repos (reducer capture + a cross-execution serve test:
artifact from `exe_old` fetched while current is `exe_fake`). **Live multi-turn
verify deferred to D1** (needs the surface server + a cluster redeploy so the
deployed api-rs emits `execution_id`).

### B1 — S3 offload (durable storage) ✅ DONE, SUPERSEDED (2026-06-18, Atrium `master` `dde26e6`)
Periodic worker + presigned 302 + `session_artifacts` table. This proved the
Centaur→Atrium→S3 durability path and locking model, but it is no longer the chosen
long-term shape.
- migration `031_session_artifacts.sql` (offload state; partial-index queue).
- mirror path records each `artifact.captured` into the table.
- worker `artifact-offload.ts` (off by default; `ARTIFACT_OFFLOAD_ENABLED=1`):
  claims a batch `FOR UPDATE SKIP LOCKED`, fetches from Centaur → `s3.uploadObject`
  (MinIO in dev) → stamps `s3_key`; single in-flight, unref'd interval.
- serve route: 302 presigned redirect once offloaded, else proxy from Centaur.
- 218 server + 51 client tests green; reviewed (access gate, presign, worker
  locking/failure).
- **Prod-hardening — long tx + evicted terminal mark ✅ DONE (2026-06-18,
  `gb/artifacts-offload-lease`):** the offload batch no longer holds a tx across
  the Centaur fetch + S3 upload. Migration `032_artifact_offload_lease.sql` adds
  `claimed_at` (lease) + `evicted_at` (terminal). `offloadArtifactBatch` now does
  claim-then-release: a short tx stamps `claimed_at` on a `FOR UPDATE SKIP LOCKED`
  batch and commits (releasing locks), then the fetch+upload run outside any tx,
  with a short per-row tx to stamp the result. A stale claim (worker crashed
  mid-upload) is reclaimable after the lease (`ARTIFACT_OFFLOAD_CLAIM_LEASE_MS`,
  default 5 min). A Centaur 404 stamps `evicted_at` (terminal) so the row drops
  out of the queue instead of re-claiming every lease. Queue index rebuilt to
  exclude `evicted_at IS NOT NULL`. 219 server tests green (added a lease test +
  extended the evicted-ref test); typecheck clean.
- **Prod-hardening — Centaur staging GC after offload:** dropped by B2; Centaur
  staging is removed instead of retained behind a retention API.
- **Live verify** (enable the worker, confirm offload → 302): superseded by B2;
  the proxy/offload leg is intentionally gone.

### B2 — Single-CAS hard cut ✅ LANDED (2026-06-25, `hardcut-single-cas`)
No committed non-delete artifact version depends on Centaur staging,
`session_artifacts`, or an offload worker. Producers write bytes into Atrium CAS/S3
first; only then does Atrium commit the ledger version.

Implemented:
- Agent/node capture uses Atrium internal capture endpoints directly and records the
  ledger commit from that durable CAS write.
- Human write-back, upload auto-land, and app publish all share the same invariant:
  `artifact_versions.blob_sha` points at a `cas_blobs` row with `s3_key`.
- `recordArtifact`, `offloadArtifactBatch`/`offloadOneArtifact`,
  `session_artifacts` table references, Centaur artifact proxy fallback, and
  artifact-offload env/docs are removed from the normal path.
- The old live in-agent poll is retired; node-sync/direct Atrium capture is the
  required production capture path before the Centaur staging dependency is deleted.
- A corrupted/non-delete version missing `s3_key` returns an explicit
  `blob_unavailable` error + metric; it is not served by proxy.

### D1 — Live-verify the Atrium serve route ✅ SUPERSEDED
The old verification goal was "Atrium route proxies from Centaur, then offload →
302." Under B2 that proxy leg is intentionally deleted, so the live verification
moves to the B2 acceptance: fresh capture commits durable CAS bytes and serves from
Atrium S3/CAS immediately.

## Dropped
- **D2 (split the api-server test module):** a fork-only split makes the whole
  module a conflict on every upstream sync (worse); `rerere` already mitigates.
  Revisit only as an upstream proposal.

## Sequence
Historical: **A1** (+ cluster migration reconcile + D1 verify, one deploy) →
**A2** → **B1** → **B2**. Forward work is live overlay/capture cutover and
full Atrium/non-mock hydration e2e.

## Pointers
- Deploy line: `fork/atrium/integration` (paradigm `origin/main` + topics). Build
  per `ATRIUM_FORK.md` / `notes/local-atrium-centaur-runbook.md`.
- Dedicated artifact key: `ARTIFACT_CAPTURE_API_KEY` (Centaur `centaur-infra-env`
  secret ↔ Atrium `surface/deploy/.env`).
- Cross-execution caveat is A2; old durable-storage scaffolding is B1; the target
  durable path is B2.
