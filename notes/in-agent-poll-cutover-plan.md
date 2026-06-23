# In-agent artifact poll → C4 node-sync: cutover & cleanup plan

> **Status: 2026-06-23. PLAN (not started).** Goal: retire the legacy in-agent poller
> (`centaur/services/sandbox/artifact_capture.py`) in favour of the C4 overlay-upper node-scan
> (`centaur-node-sync` daemon), **without losing capture coverage or safety filters**.
> Grounded in a code sweep of both repos (file:line below). Companion:
> [`c4-overlay-provisioning-plan.md`], [`shared-workspace-build-spec.md`], [[c4-overlay-capture-build]].

## 0. The two mechanisms today (grounded)

| | Legacy in-agent poll | C4 node-sync daemon |
|---|---|---|
| Code | `services/sandbox/artifact_capture.py` (launched `entrypoint.sh:539`, copied `Dockerfile:218`) | `services/api-rs/crates/centaur-node-sync/` (`centaur-node-syncd`) |
| Where it runs | **inside every sandbox pod** | privileged **node DaemonSet** (O(nodes)) |
| Scan | stat-walks the **whole** `DEFAULT_DIRS=/home/agent/workspace:/tmp:/home/agent/outputs:/var/tmp` every **2.5s** = O(all files) | reads the overlay **upper** = O(changes), interval 2s (`scanIntervalSeconds`) |
| Ingest | POST `{api}/agent/executions/{id}/artifacts` (**Centaur** `routes.rs:507`) | POST `/api/internal/sessions/{id}/artifacts/capture` (**Atrium**) |
| Filters | secret-**content** scan (`secret_denied`), MIME allow-list (`image/audio/video`+set), `.git`/`node_modules` excludes, junk-extension, **1 MiB** soft cap | path-based deny (`classify_entry` denies `.git-credentials` etc., routes harness homes off-artifact, excludes repos via `.git`); large-file **streaming** to S3 |
| Gate | `ARTIFACT_CAPTURE_ENABLED` default **1** (on) | `nodeSync.enabled` default **false** (off); controller `overlay: None` |

**Current production reality:** the poll is the **active, default, and only-live** capture path. C4 is
**gated off and not wired into the live controller** (`overlay: None`, `nodeSync.enabled=false`). There is
**no cutover coupling** — nothing disables the poll when C4 is on. So the poll **cannot be deleted today**
without stopping all capture.

**Correction to an earlier framing:** the overlay **mechanism, capture round-trip, and hydration ARE
kind-validated** (5B-1/5B-2 + PRs #12/#13 — the `node-sync-pod-e2e` captures + the agent reads
`/workspace/shared/hydrated.md`). The remaining gap is **wiring C4 into the live api-rs controller +
validating the real session-spawn path**, NOT "the mount is unproven."

## 1. Side effects & couplings (the map)

1. **Two ingest routes diverge.** Poll → Centaur `/agent/executions/{id}/artifacts` (`routes.rs:507`, GET
   variant `:529`); daemon → Atrium `/api/internal/sessions/{id}/artifacts/capture`. The sweep found the
   Centaur route is **poller-only** (only caller `artifact_capture.py:244`; tests mock it). So deleting the
   poll **orphans** that Centaur route (+ handler + tests) — they come out in cleanup. *Re-confirm no other
   caller before deleting.*
2. **Filter parity (the real work item).** The daemon lacks the poll's **secret-content scan** (security —
   a `notes.txt` with an embedded key: poll blocks, daemon captures), **junk-extension/binary filtering**
   (bloat), and a soft **size cap**. The MIME *allow-list* is a deliberate philosophy difference — the shared
   workspace wants **all deliverables**, so replace the allow-list with a **deny-list** (junk/build-artifact
   extensions) + the secret-content scan. The 1 MiB cap is *superseded* by the daemon's large-file streaming
   (an improvement, not a gap).
3. **Dir coverage gap.** Poll covers `/tmp`, `~/outputs`, `/var/tmp`; the overlay upper only covers
   `/workspace`. The sweep found **no code evidence** the harness writes artifacts to those (transient/debug).
   Decision needed: **drop them** (document "write deliverables under `/workspace`") — recommended — or add
   them as extra capture roots.
4. **Workspace-model swap (biggest runtime change).** Today `entrypoint.sh:368-393` git-clones the repo into
   `~/workspace` and `cd`s there (`:429`); branch `agent-<ts>` (`:388`). The overlay model puts the repo in
   an **RO lower** + an **upper** merged at `/workspace`. **VALIDATED 2026-06-23** (privileged Linux-VM
   overlay test, see §4): `git status / checkout -b / commit / log / switch / worktree add / push` ALL work
   on the overlay (`.git/` copies up transparently; `--shared` clone alternates resolve through the lower;
   `git fsck` clean; push lands the branch on the bare forge). So the git mechanics are NOT a blocker.
   **The model (Gary's): provision the repo lower at a configurable base ref, then let the agent branch /
   switch / worktree itself** — drop the forced `agent-<ts>` from the entrypoint. The entrypoint change is
   just: gate `CENTAUR_OVERLAY_ENABLED` (default off ⇒ byte-identical clone path); when on, **skip the clone**
   (repo is the RO lower, mounted by the daemon), `cd /workspace`, no forced branch. The controller's overlay
   wiring already exists, gated (5B-2 `--sandbox-overlay-provisioning`).
5. **Resume is orthogonal** (`entrypoint.sh:457-526` restore runs before capture; different endpoint).
   No blocker today; future inbound-sync hydration couples resume→artifacts (one-way), not the reverse.
6. **Backward compat.** Non-overlay sandboxes must keep the poll until the overlay is the universal default —
   so the poll's removal is gated on the overlay being on everywhere.

## 2. Phased plan

**Phase 0 — Parity prerequisites (build; no behavior change):**
- **0a (HARD, security):** port the poller's secret-**content** scan into the daemon's capture path (scan the
  sample before upsert; mirror `secret_denied`).
- **0b:** add a deny-list filter to the daemon (junk/binary extensions; optional soft size policy) — keep
  "capture all workspace deliverables" but drop obvious junk/build artifacts.
- **0c:** decide `/tmp`+`~/outputs`+`/var/tmp` — recommend **drop + document**; else add capture roots.
- **0d (HARD — validated-essential): exclude `.git/` internals from the Artifact lane.** The overlay test
  (§4) showed one `git commit` floods the upper with `.git/HEAD`, `.git/index`, `.git/objects/*`, refs.
  `classify_entry` (`runtime.rs:178-191`) currently routes those to `Artifact` → it'd capture git metadata as
  artifacts (pure churn-per-commit, never a deliverable). Route any path containing a `.git/` segment to
  `Denied`. (The legacy poll dodged this via its MIME allow-list + `.git` exclude.)
- **0e (OPEN DESIGN DECISION — do NOT blind-filter):** do we capture an agent's *edits to tracked repo
  source* (e.g. `src/main.rs`)? §10.7 distinguishes **capture-for-history** (maybe yes — a record of what
  the agent changed) from **share-across-containers** (never — git owns code). The 5B-2 pod-e2e *asserts*
  a new file under a composed-repo subdir IS captured, so a blanket repo-subtree exclusion would break it.
  Resolve the policy (likely: capture-but-don't-share, keyed off path scope) before touching this — it is
  NOT part of the safe Phase-0 lane.

**Phase 1 — Make C4 the live capture path (the real remaining edge):**
- **1a:** wire the overlay into the live api-rs controller (`overlay: Some(...)`, currently `None`); flip
  `nodeSync.overlayProvisioning.enabled` + `nodeSync.enabled`. Per-tenant isolation per the C4 plan (#65).
- **1b:** entrypoint refactor behind a flag (e.g. `CENTAUR_OVERLAY_ENABLED`): skip the git-clone, `cd
  /workspace`, retire/move the `agent-<ts>` branch logic. Controller provisions the repo RO-lower first.
- **1c:** validate the **real session-spawn** path on a real cluster (spawn → agent writes → daemon captures
  → Atrium ledger → offload → serve), beyond the synthetic e2e pods.

**Phase 2 — Parallel run + parity check:**
- Run **both** (poll + daemon) for a bake period; diff captured sets (path, sha256, count). Proceed only on
  parity modulo the intentional dir-coverage/junk differences.

**Phase 3 — Cutover (flip default, keep rollback):**
- Default `ARTIFACT_CAPTURE_ENABLED=0` when the overlay is active; keep the poll behind the flag for one
  release (instant rollback).

**Phase 4 — Cleanup (after a release of poll-off):**
- Delete `artifact_capture.py`, the `entrypoint.sh:532-539` launch block, the `Dockerfile:218` COPY, the
  `ARTIFACT_CAPTURE_*` env vars.
- Delete the orphaned Centaur ingest route `/agent/executions/{id}/artifacts` (+ GET `:529`) + its handler +
  tests (after re-confirming poller-only).
- Update docs/memories; drop the "2.5s poll fallback" language from the C4 plan.

## 3. Removal blockers (corrected)

**Must be true before deletion:**
1. Secret-content scan implemented in the daemon (Phase 0a). *(security)*
2. C4 wired into the **live controller** + real-session-spawn validated (Phase 1) — *not* "mechanism unproven"
   (that's done); this is the production wiring.
3. Parallel parity bake passes (Phase 2).
4. Poll-off shipped + baked one release with rollback (Phase 3).
5. Dir-coverage + junk-filter decisions made + documented (Phase 0b/0c).

**Not blockers (corrected):** overlay mount validation (done in kind, #12/#13); **git commit/push/worktree on
the overlay (VALIDATED §4)**; large-file handling (daemon streaming beats the 1 MiB cap); resume (orthogonal).

## 4. Validation log

- **git-on-overlayfs (2026-06-23, privileged `alpine` container in the Docker-Desktop Linux VM, kernel
  `6.12-linuxkit` — the same kernel/overlayfs the kind node uses):** with the repo as the RO lowerdir + a
  tmpfs-backed upper/work, `git status / checkout -b / add / commit / log / switch / worktree add` all
  succeed; a `git clone --shared`-style lower's `objects/info/alternates` resolve through the overlay
  (`git fsck --connectivity-only` clean); `git push` of the agent branch to a bare forge succeeds. ⇒ the
  configurable-base-ref + agent-self-branch model is sound; the git workflow is not a cutover risk.
- **Caveat (overlay backing):** the upper/work/lower must NOT sit on another overlayfs — nesting fails with
  `mount: Invalid argument` (the container rootfs is overlay; the real node uses an **ext4 hostPath**, which
  is fine). This is the same nested-overlay constraint the C4 plan already designs around.
