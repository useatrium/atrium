# In-agent artifact poll → C4 node-sync: cutover & cleanup plan

> **Status: 2026-06-25. SUPERSEDED BY THE SINGLE-CAS HARD CUT + NODE-SYNC DEFAULT.**
> The legacy in-pod artifact poller and Centaur artifact staging API are no longer
> the normal path in the Atrium fork. Centaur `fork/main` now enables node-sync and
> overlay provisioning by default, the `centaur-node-sync` image includes
> `provision-overlay`, and captures go directly to Atrium CAS/S3 through internal
> session routes. Keep this file as historical cutover context for safety filters
> and operational sequencing; use [`shared-workspace-build-spec.md`] lane F/G and
> [`local-atrium-centaur-runbook.md`] for current bring-up.

> **Current local verification, 2026-06-25:** local kind has the node-sync DaemonSet
> running and api-rs overlay provisioning enabled. After attaching the Atrium prod
> server container to the `kind` Docker network, node-sync posted artifact captures
> with `0 errors`; Atrium's local prod DB had no `session_artifacts` table and
> durable `cas_blobs.s3_key` rows.

## Decisions locked (2026-06-23, Gary)

- **Next = COMPLETE THE CUTOVER (Gary 2026-06-23):** daemon-only + delete the poll, on the **flat-`~`** layout
  (see [`flat-home-workspace-design.md`]). Execute via **agent-fanout**, land to main with **green CI
  incrementally**, run to completion; **checkpoint only** the two irreversible prod steps (flip
  `ARTIFACT_CAPTURE_ENABLED=0`, delete the poll).
- **0e = do NOT capture repo source** ("git owns it"): exclude paths under a repo working tree from the
  Artifact lane (deliverables live OUTSIDE repo roots, §10.7). **Reverses the 5B-2 e2e** (which captured a
  file inside `foo/`) → that e2e is updated to capture *outside* the repo + assert *non*-capture inside.
- **0c → SINGLE CAPTURED ROOT (revised 2026-06-23; supersedes "keep /tmp"):** capture **only the agent's
  working directory**, nothing else. **DROP `/tmp` + `/var/tmp` + `~/outputs`** as capture roots (the §1.3 sweep
  + the live probe found no deliverables there; `/tmp` is scratch, `TMPDIR` unset). The working dir is
  `~/workspace` **today** (the poll's first dir = the agent CWD) and *relocates* to the C4 working-dir mount at
  cutover (designed as `/workspace`; whether it should instead be a flat-`~` is the **open fork §6**). One
  captured dir in both eras. **Supersedes 1d** — no `/tmp` watch-root infra. *(Corrects an earlier wrong note
  that "`~` is not scanned today": today the poll DOES scan `~/workspace`+`~/outputs`, and there is no
  `/workspace` yet.)*
- **Poll end-state = full delete after cutover** (no permanent fallback) — Phase 4 removes the poller +
  entrypoint launch + Dockerfile copy + the orphaned Centaur `/agent/executions/{id}/artifacts` route + tests.
- **Harness-transcript lane is the daemon's (see §1.5 correction)** — go-live validates it; cleanup keeps it.
- **Cleanup now:** 0e repo-tree exclusion (+ e2e flip) and removing the vestigial `runtime::hydrate_lower`
  (only test callers; live path is `cas::hydrate_artifact_lower`).

## Status ledger (updated 2026-06-23)

| Item | Phase | Status | Landed |
|---|---|---|---|
| Secret-content scan in the daemon | 0a | ✅ done | centaur #15 (`a09eb35`) |
| Junk/binary deny-list | 0b | ✅ done | centaur #15 |
| Exclude `.git/` internals from the Artifact lane | 0d | ✅ done | centaur #15 |
| Repo-working-tree exclusion | 0e | ✅ done | centaur #16 (`04c11fc`) |
| Drop vestigial `runtime::hydrate_lower` | cleanup | ✅ done | centaur #16 |
| Gated overlay-workspace entrypoint (default-off) | 1b | ✅ done (gated) | centaur #14 (`6a9d2ff`) |
| Decisions locked + §5 resume-coupling fix + 4-lane taxonomy | docs | ✅ done | atrium #88 (`be059a7`) |
| ~~`/tmp`+`/var/tmp` watch roots (1d)~~ → **dropped** (single captured root, 0c) | — | ❌ not needed | — |
| Live-controller wiring (`overlay: Some`, `nodeSync.enabled`) | 1a | ✅ built/enabled in fork chart defaults | Centaur `fork/main` |
| Real-session-spawn validation — **both** lanes | 1c | ✅ local kind + Atrium prod smoke for node-sync capture; real-model harness resume remains a separate watched e2e | 2026-06-25 local |
| Parity bake (poll vs daemon captured-set diff) | 2 | Superseded by hard cut | — |
| Flip default `ARTIFACT_CAPTURE_ENABLED=0` + rollback bake | 3 | Superseded by poll/staging removal in fork | — |
| Delete poller + entrypoint launch + Dockerfile COPY + orphaned route | 4 | ✅ done for artifact staging route/path in fork | Centaur `fork/main` |

**Net:** this plan's "how do we safely get off the in-agent poll?" question is
closed for the Atrium fork's artifact path. Remaining platform work is broader
workspace sync/product scope, not preserving the old Centaur artifact staging
route.

## 0. The two mechanisms today (grounded)

| | Legacy in-agent poll | C4 node-sync daemon |
|---|---|---|
| Code | `services/sandbox/artifact_capture.py` (launched `entrypoint.sh:539`, copied `Dockerfile:218`) | `services/api-rs/crates/centaur-node-sync/` (`centaur-node-syncd`) |
| Where it runs | **inside every sandbox pod** | privileged **node DaemonSet** (O(nodes)) |
| Scan | stat-walks the **whole** `DEFAULT_DIRS=/home/agent/workspace:/tmp:/home/agent/outputs:/var/tmp` every **2.5s** = O(all files) | reads the overlay **upper** = O(changes), interval 2s (`scanIntervalSeconds`) |
| Ingest | POST `{api}/agent/executions/{id}/artifacts` (**Centaur** `routes.rs:507`) | POST `/api/internal/sessions/{id}/artifacts/capture` (**Atrium**) |
| Filters | secret-**content** scan (`secret_denied`), MIME allow-list (`image/audio/video`+set), `.git`/`node_modules` excludes, junk-extension, **1 MiB** soft cap | path-based deny (`classify_entry` denies `.git-credentials` etc., routes harness homes off-artifact, excludes repos via `.git`); large-file **streaming** to S3 |
| Gate | Historical only in the Atrium fork | `nodeSync.enabled` default **true**; controller overlay provisioning enabled |

**Current Atrium fork reality:** C4/node-sync is the normal artifact capture path.
If node-sync logs `No route to host` in local kind, fix the Atrium container
networking and node-sync egress values; do not revive the old staging route.

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
3. **Dir coverage gap → RESOLVED (single captured root, 0c).** Today the poll captures `~/workspace` +
   `~/outputs` (both under `~`) + `/tmp` + `/var/tmp`; under C4 the captured surface is the one working-dir
   mount. The sweep + live probe found **no deliverables** in `/tmp`/`/var/tmp`/`~/outputs` (transient/scratch).
   **Decision: capture only the working dir; DROP `/tmp`+`/var/tmp`+`~/outputs`.** Document "deliverables go in
   your working directory." (No `/tmp` watch-root infra — see superseded 1d.)
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
5. **Resume — RESTORE is orthogonal, CAPTURE is COUPLED (correction, 2026-06-23).** The entrypoint
   *restore* (`:457-526`, GET `/harness-transcript`) is independent of the daemon. But per-turn transcript
   *capture* is the DAEMON's job and its **sole** producer: `centaur-node-syncd.rs:700`
   `harness_transcript_sweep` → `put_harness_transcript` → PUT `/harness-transcript` → S3 (`mig 037`,
   `harness_transcripts` table) — a **separate lane/endpoint from the artifact ledger** (so it never pollutes
   Files/the change-feed, per `harness-resume-build-plan.md`), but the **same producer**, gated by the same
   `nodeSync.enabled`. The poll NEVER touches the transcript (zero refs). ⇒ daemon off (today) ⇒ nothing
   captures the transcript per-turn ⇒ **cold-start resume has nothing fresh to pull** (resume isn't live in
   prod yet). **Going live (Phase 1) turns on BOTH lanes** — Phase 1c must validate the harness-transcript
   lane too, and Phase-4 cleanup must NEVER drop it.
   **4-lane taxonomy** (corrects the earlier "captured vs never-synced" binary; `classify_entry` `runtime.rs:164`):
   (a) **Artifact**→CAS ledger; (b) **HarnessTranscript**→S3 via `/harness-transcript` (the one resume JSONL,
   SYNCED); (c) **HarnessState**→rest of `.claude`/`.codex` config/cache, NOT server-synced (persistent
   `state/` volume only, warm restart); (d) **Denied**→auth/keys, never synced, iron-proxy re-injects. So part
   of `.claude`/`.codex` (the transcript) IS designed to sync; "auth never an artifact" stays load-bearing.
6. **Backward compat.** Non-overlay sandboxes must keep the poll until the overlay is the universal default —
   so the poll's removal is gated on the overlay being on everywhere.

## 2. Phased plan

**Phase 0 — Parity prerequisites (build; no behavior change):**
- **0a (HARD, security):** port the poller's secret-**content** scan into the daemon's capture path (scan the
  sample before upsert; mirror `secret_denied`).
- **0b:** add a deny-list filter to the daemon (junk/binary extensions; optional soft size policy) — keep
  "capture all workspace deliverables" but drop obvious junk/build artifacts.
- **0c (DECIDED → single captured root):** capture only the working dir; **drop `/tmp`+`/var/tmp`+`~/outputs`**.
  Document "deliverables go in your working directory." Supersedes 1d.
- **0d (HARD — validated-essential): exclude `.git/` internals from the Artifact lane.** The overlay test
  (§4) showed one `git commit` floods the upper with `.git/HEAD`, `.git/index`, `.git/objects/*`, refs.
  `classify_entry` (`runtime.rs:178-191`) currently routes those to `Artifact` → it'd capture git metadata as
  artifacts (pure churn-per-commit, never a deliverable). Route any path containing a `.git/` segment to
  `Denied`. (The legacy poll dodged this via its MIME allow-list + `.git` exclude.)
- **0e (RESOLVED 2026-06-23 → landed centaur #16):** repo working trees are **excluded from the Artifact
  lane** ("git owns repo source; deliverables live outside repo roots", §10.7). `classify_entry` /
  `partition_entries_by_lane` now take the session's repo subdirs (threaded from the manifest via
  `repo_target_subdir`) and **Deny** any path whose first component is a repo subdir. The 5B-2 pod-e2e was
  **flipped** to match: it now captures an *outside*-repo deliverable (`/workspace/outside-deliverable.txt`)
  and asserts the *in*-repo write (`foo/agent-created.txt`) lands in the upper but is **NOT** captured.
  (The earlier framing treated this as an open "capture-for-history vs share" fork; the locked decision is
  **do not capture repo source at all** — git is the record. Per-path-scope capture-but-don't-share can
  revisit later if ever wanted, but it is explicitly out of scope now.)

**Phase 1 — Make C4 the live capture path (the real remaining edge):**
- **1a:** wire the overlay into the live api-rs controller (`overlay: Some(...)`, currently `None`); flip
  `nodeSync.overlayProvisioning.enabled` + `nodeSync.enabled`. Per-tenant isolation per the C4 plan (#65).
- **1b:** entrypoint refactor behind a flag (e.g. `CENTAUR_OVERLAY_ENABLED`): skip the git-clone, `cd
  /workspace`, retire/move the `agent-<ts>` branch logic. Controller provisions the repo RO-lower first.
- **1c:** validate the **real session-spawn** path on a real cluster (spawn → agent writes → daemon captures
  → Atrium ledger → offload → serve), beyond the synthetic e2e pods.
- **1d (SUPERSEDED 2026-06-23 by the single-root decision (0c) — kept only as the analysis of *why* capturing
  `/tmp` is hard, should we ever revisit):** `/tmp` +
  `/var/tmp` are real dirs at the **container root** (mode `1777`, siblings of `/home`) that live on the
  **container's own rootfs overlay** (containerd) — a *different filesystem* from the C4 artifact overlay at
  `/workspace`. The node daemon scans the artifact-overlay **upper at a session-keyed node hostPath**; it has
  **no session-keyed handle to the container rootfs**, so it CANNOT reach `/tmp` by adding a path to a scan list.
  Capturing `/tmp` the daemon way means **mounting `/tmp`+`/var/tmp` from a session-keyed, node-visible volume**
  (emptyDir/hostPath over them — the same property the harness-transcript lane relies on, where `~/.claude` sits
  on the state PVC) and scanning *that*: a **pod-spec + provisioning change**, not a config toggle. Apply the
  Phase-0 filters there too. Drop `~/outputs`.
  **Decide before building (options):** (1) session-keyed tmp volume + daemon scan-root [cleanest; real infra];
  (2) `TMPDIR=/workspace/.tmp` redirect [leaky — many tools hardcode `/tmp`, and it pollutes the ledger];
  (3) keep a `/tmp`-only in-pod poll [defeats the cutover]; (4) **drop `/tmp` capture + document "deliverables
  go under `/workspace`"** [recommended — the §1.3 sweep found no deliverables in `/tmp`, and `TMPDIR` is unset
  = pure scratch]. **Without 1d, cutover silently loses today's `/tmp` capture** (the poll scans it now).

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
5. Dir-coverage + junk-filter: decided ✅ — 0b done (#15); **0c = single captured root** (capture only the
   working dir; drop `/tmp`+`/var/tmp`+`~/outputs`). No `/tmp` watch-root infra needed (1d superseded). Document
   "deliverables go in the working dir."

**Not blockers (corrected):** overlay mount validation (done in kind, #12/#13); **git commit/push/worktree on
the overlay (VALIDATED §4)**; large-file handling (daemon streaming beats the 1 MiB cap). **Resume is NOT a
non-blocker — corrected (§1.5):** restore is orthogonal, but per-turn transcript *capture* is the daemon's lane
(same `nodeSync.enabled` gate), so go-live must validate it and cleanup must keep it.

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
- **`/tmp` topology + access (2026-06-23, LIVE probe — `asbx-…` pod on the kind `centaur` cluster, as agent uid 1001):**
  `id` = `uid=1001(agent)`, `HOME=/home/agent`, `TMPDIR` **unset**. `/tmp` and `/var/tmp` are real dirs at the
  **container root** (`drwxrwxrwt root:root`, mode `1777` — sticky, world-writable), **siblings of `/home`**, NOT
  symlinks, NOT under `~`. Write probe as the agent: `/tmp` ✅, `/var/tmp` ✅, `/` ✗ (perm-denied — `/` is
  `root:root` 755; **`readOnlyRootFilesystem` is unset** (`tools.rs:109`), so the rootfs is `rw` and only unix
  perms gate it). `df`: both sit on the **container rootfs overlay** (containerd) — the SAME fs as `/`, *not* tmpfs,
  *not* a mounted volume. These (legacy-model) pods have **no `/workspace` overlay** (workspace is a plain
  `~/workspace` dir; `/home/agent/github` is a RO ext4 hostPath; poll active by default). ⇒ Confirms the §1.3 gap
  AND the 1d stress-test: under C4 the node daemon (scanning the artifact-overlay upper at a session-keyed node
  path) is **structurally blind to `/tmp`**, which lives on a *different* overlay it holds no session-keyed handle
  to. Capturing `/tmp` ⇒ a node-visible session-keyed tmp volume (1d), never a scan-list toggle.

## 5. Go-live build + test matrix (must be built AND tested before deletion)

**Build (remaining):**
- [ ] **1a** controller wiring: `overlay: Some(...)` (currently `None`); flip `nodeSync.overlayProvisioning.enabled`
  + `nodeSync.enabled`; per-tenant isolation (#65).
- [ ] **Single-root capture (0c):** daemon captures **only the working dir** (the C4 working-dir mount); confirm
  `/tmp`+`/var/tmp`+`~/outputs` are NOT captured. Document "deliverables go in your working dir."
- [ ] **3** cutover coupling: auto `ARTIFACT_CAPTURE_ENABLED=0` when the overlay is active; poll behind a flag
  for one release (instant rollback).
- [ ] **4** deletion: `artifact_capture.py`, the `entrypoint.sh` launch block, the `Dockerfile` COPY, the
  `ARTIFACT_CAPTURE_*` env vars, and the orphaned Centaur `/agent/executions/{id}/artifacts` route + handler + tests.

**Test (must pass before flipping the default / deleting):**
- [ ] **Artifact lane, real spawn:** real session on a real cluster → agent writes a deliverable under `/workspace`
  → daemon captures → Atrium ledger version → offload to S3 → serve-by-path returns the bytes (sha match). (1c, beyond synthetic pods.)
- [ ] **Harness-transcript lane, live:** daemon on → a turn's transcript is captured (PUT `/harness-transcript`
  → `harness_transcripts`/S3) → kill + cold-start the pod → entrypoint restore pulls it → agent resumes with prior
  context. (The lane the poll never covered; newly live at go-live — §1.5 correction.)
- [ ] **Repo-tree exclusion, real spawn:** agent edits a tracked repo file (`foo/src/x`) AND writes an outside
  deliverable → only the outside file is captured; the in-repo edit is in the upper but NOT in the ledger. (0e end-to-end.)
- [ ] **`.git`/junk/secret filters, real spawn:** a `git commit` in the overlay → no `.git/*` artifacts; a `notes.txt`
  with an embedded key → skipped (secret-scan); a `*.o` / `node_modules` write → skipped. (0a/0b/0d end-to-end.)
- [ ] **OS scratch is NOT captured (0c):** agent writes `/tmp/x` or `/var/tmp/y` → none land in the
  ledger (intentional); a write in the working dir DOES. In the 2026-06-25 shared-workspace model,
  `~/scratch` is different: it is captured as `scratch/<session-id>/...` with a session-scoped ACL.
- [ ] **Parity bake (Phase 2):** poll + daemon run together; diff captured sets (path, sha256, count); parity
  modulo the intended dir-coverage/junk deltas.
- [ ] **Rollback:** flip back to the poll (daemon off / `ARTIFACT_CAPTURE_ENABLED=1`) → capture continues, no data
  loss across the flip.
- [ ] **Backward compat:** a non-overlay sandbox still captures via the poll until the overlay is the universal default.

## 6. Design fork — RESOLVED 2026-06-23 → Model B (flat-`~`). See [`flat-home-workspace-design.md`].

**Decision (Gary): flat-`~`** — the agent's home IS its workspace; **capture = non-dotfile home entries except
`repos/`+`context/`**; auth via **separate mounts (structural) + the dotfile rule + the secret-scan**. The
analysis below is kept for the record. **Both models keep `/tmp` as ordinary uncaptured scratch.**

- **Model A — `/workspace` mount (current C4 design).** Working dir = a top-level `/workspace` overlay,
  *separate* from `~`. `~` (`.claude`/`.codex`/`state`) stays **structurally** outside the captured zone (the
  `#72 P4` typed-root boundary). The agent has a distinct "workspace" concept. **Auth safety = structural.**
- **Model B — flat-`~` (the "live in your home" UX).** Working dir = `~` itself; the agent lives in its home
  like a normal Unix user (home = kept/captured, `/tmp` = OS scratch). No separate "workspace" concept; aligns with
  the planned `~/shared`,`~/scratch`,`~/repos`,`~/context` rename. **Cost:** the auth carve-out (`.claude`/`.codex`/`state`)
  becomes a **deny-list** boundary (`classify_entry`, already implemented) instead of a structural one — a
  posture downgrade vs `#72 P4` (a deny-list bug ⇒ auth leaks as an artifact).

**Independent of A/B:**
- **`readOnlyRootFilesystem` hardening** (block writes to `/usr`,`/etc`, system bins) is worth doing on its own,
  but it canNOT remove a writable `/tmp` (libc/pip/npm/git + the entrypoint's own `mktemp` need one) — so it does
  not, by itself, constrain the agent to `~`.
- **Symlinking/hardlinking `/tmp`→`~/tmp` does not help:** dir hardlinks are forbidden (POSIX); a `/tmp`→`~/tmp`
  symlink only gets captured if `~` is the captured root (Model B) AND you accept scratch pollution (then you'd
  re-exclude it). `/tmp` stays scratch regardless — the real question is only **A vs B for the *kept* surface.**
