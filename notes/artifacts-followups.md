# Artifacts — follow-up plan

Status of the sandbox artifact-capture feature after the 2026-06-18 build-out +
live end-to-end verification. The full pipeline (sandbox worker → api-rs capture
routes → Postgres staging → `artifact.captured` event → byte serve) is **proven
working in the live local cluster**; Atrium's serve route is implemented +
test-green. This tracks what's left.

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

### A1 — Proper sandbox→api-rs egress NetworkPolicy
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

### A2 — Per-artifact `execution_id` on the wire
Serve route falls back to the session's `current_execution_id`, so artifacts
from an earlier turn of a multi-turn session 410.
- **Fix:** Centaur adds `"execution_id"` to the `artifact.captured` payload
  (~1 line in `capture_artifact`, no migration); Atrium reducer keeps
  `executionId` on `Artifact`; serve route uses it.
- **Effort:** S–M. Do before B1.

### B1 — S3 offload (durable storage)
Centaur Postgres staging is ephemeral (retention/redaction) → artifacts evict →
410. Move bytes to Atrium's S3.
- **Scope:** `session_artifacts` table (id, session_id, execution_id,
  centaur_ref, s3_key, mime, size, sha256, captured_at, offloaded_at) · offload
  worker (fetch from Centaur → `s3.ts` `uploadStream` → record `s3_key`) · serve
  route prefers S3 (presigned redirect) then falls back to Centaur proxy.
- **Effort:** M–L. **Depends on A2.**
- **Decisions:** periodic worker vs. on-completion (recommend periodic);
  single-worker lock; Centaur staging GC after offload (blocked on a Centaur
  retention API — defer).

### D1 — Live-verify the Atrium serve route
Centaur's byte endpoint is live-verified; the Atrium route → Centaur link is
only test-verified. Bring the surface stack up with the dev key, drive a session,
hit the route. **Fold into A1's redeploy.**

## Dropped
- **D2 (split the api-server test module):** a fork-only split makes the whole
  module a conflict on every upstream sync (worse); `rerere` already mitigates.
  Revisit only as an upstream proposal.

## Sequence
**A1** (+ cluster migration reconcile + D1 verify, one deploy) → **A2** → **B1**.

## Pointers
- Deploy line: `fork/atrium/integration` (paradigm `origin/main` + topics). Build
  per `ATRIUM_FORK.md` / `notes/local-atrium-centaur-runbook.md`.
- Dedicated artifact key: `ARTIFACT_CAPTURE_API_KEY` (Centaur `centaur-infra-env`
  secret ↔ Atrium `surface/deploy/.env`).
- Cross-execution caveat is A2; durable storage is B1.
