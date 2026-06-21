# Agent workspace sync — full implementation plan (both halves)

> **Status: IMPLEMENTATION PLAN (2026-06-20).** Turns the settled design
> (`agent-sync-design.md` §1–9 + §8B's 20 resolutions) and the lane sketch
> (`inbound-sync-build-plan.md`) into an executable, phased, test-gated build across
> **both repos** — Atrium (`~/Code/atrium`, TS/SQL) and Centaur
> (`~/Code/centaur`, Rust + Python + k8s). Scope decided with Gary 2026-06-20:
> **full code both halves**; **unified Files surface IN scope**; **delete-vs-edit =
> record-as-conflict, never auto-pick**; Centaur source is local + a kind cluster is
> available (single-machine; multi-process real-node linchpin validated as far as the
> Mac/linuxkit allows).

## Orientation — what's already shipped (don't rebuild)

| Capability | Status | Where |
|---|---|---|
| CAS-ledger (S3 CAS + PG version chain, movable pointers) | **built** | mig `033`, `artifact-ledger.ts` |
| Write-back PUT + OCC + node-diff3 (merge-class-gated) + `status=conflict` | **built** | `artifact-writeback.ts` |
| Conflict-aware `commitVersion` (stale-base detection, dedup, idempotent) | **built** | `artifact-ledger.ts` |
| Serve latest-by-path | **built** | `app.ts` `/api/sessions/:id/artifacts/by-path` |
| Blob GC lease worker | **built** | `artifact-ledger-gc.ts` |
| Time-watermarked change source (`changedSince`) | **built but NOT gap-free** | `artifact-ledger.ts` — Phase 1 replaces with a gap-free cursor (§8B #7) |
| Centaur **in-container** capture (2.5s poll) | **built** (artifact-capture branch) | `services/sandbox/artifact_capture.py`, mig `1000`, api-server routes |
| Centaur **node-scan** capture (C4) | **NOT built** | Phase 4 |
| Hydration manifest + lower materialization | **NOT built** | Phase 5 |
| Node-side inbound merge + quiesce | **NOT built** | Phase 6 |
| `/atrium` context projection | **NOT built** | Phase 7 |

## Tracks

- **A — Atrium** (TS/SQL, this repo): change-feed, conflict UX, scope query, unified Files
  surface, per-path sync-state. *No Centaur dependency — lands the live human/in-app
  conflict loop immediately.*
- **C — Centaur** (Rust/Python/k8s): overlay provisioning, node-scan capture, hydration,
  node-side merge, `/atrium` projection, quiesce. *Gated on the kind cluster.*
- **V — Validation**: kind cluster, the `mountPropagation` linchpin, e2e, the 20-issue matrix.

Coverage of the §8B issues is tracked per phase in the **"§8B issues closed"** line.

---

## Phase 0 — Environment & baseline (gate: both suites green)

**Goal:** reproducible test substrate before any code changes; a measured baseline.

- **A:** `docker compose -f surface/docker-compose.yml up -d` → PG `:5433` + MinIO `:9000`;
  run `pnpm -C surface/server migrate`; run the artifact suite to baseline-green.
- **C:** `cargo build` the `services/api-rs` workspace off a fresh branch from
  `gb/api-rs-artifact-capture`; `cargo test` baseline; `cargo test -p centaur-session-runtime`.
  Bring up a kind cluster (`kind create cluster --name centaur`); confirm node access
  (`kubectl get nodes`, a privileged debug pod can `mount` an overlay).
- **Branches:** Atrium → `feat/sync-c1` off `master`; Centaur → `feat/sync-node` off
  `gb/api-rs-artifact-capture`.

**Tests / exit:** `pnpm -C surface/server test` green; `cargo test` green; kind cluster up;
a privileged pod confirms overlay mount + `mountPropagation` is wireable on this node.

---

## Phase 1 — A1: gap-free change-feed + per-path sync-state  (closes #2, #7)

**The "one root" fix (§8A takeaway #1): one source of truth for current base + byte-origin
per path.** This underpins echo-loop suppression, base-advance, and conflict-clear together.

- **Mig 034:**
  - `artifact_changes` **outbox** — `(id bigserial, artifact_id, seq, path, base_seq, sha,
    status, kind, created_at)`, appended by a trigger on `artifact_versions`. Cursor is a
    **gap-free watermark** (commit-ordered): consume rows `id > cursor` **only up to**
    `pg_snapshot_xmin(pg_current_snapshot())` so an in-flight slower txn is never skipped
    (§8B #7; the naive `max(id)` drops rows). Document the **logical-replication-slot (LSN)**
    variant as the prod-scale swap (gap-free by construction; needs `wal_level=logical`).
  - `artifact_sync_state` — `(session_id, path, base_seq, base_sha, upper_sha,
    applied_remote_seq, updated_at)`: the per-path state record (§8B #2). Server-authoritative
    so the node is crash-recoverable; the node mirrors it.
- **Endpoint:** `GET /api/sessions/:id/artifacts/changes?since=<cursor>` →
  `{ rows: [{path, seq, base_seq, sha, status, kind}], next_cursor }`. Egress-pollable,
  resumable, gap-free. Keep `pg_notify('artifact_advanced')` for the in-app WS hub.
- **Echo suppression:** a version whose `(path, sha)` equals a recorded
  `applied_remote_seq` intent is flagged `origin=node-merge` and filtered/idempotent in the
  feed (§8B #2, POC-verified suppression).

**Tests (vitest, live PG):**
- gap-free under concurrent commits — a slow txn committing an earlier `id` after a fast txn
  is **still delivered** (the #7 race; assert no skip);
- cursor resume across restart;
- `status=conflict` rows surface;
- echo-loop write is suppressed/idempotent;
- `artifact_sync_state` advances `base_seq` after a clean adopt (kills stale-base false-conflict).

**§8B issues closed:** #2 (echo/base), #7 (cursor).

---

## Phase 2 — A2 follow-ups + A3 conflict UX + A4 scope + delete-vs-edit  (closes #5, #14; confirms #5-serve)

- **A2:** confirm the merge-class gate matches §10.6 (immutable-data=never-diff3,
  mergeable-doc=diff3, JSON/YAML/CSV/ipynb→whole-file conflict-state). Add the
  **delete-vs-edit** path: a stale-base capture where one side is a delete tombstone records a
  `status=conflict` version carrying both sides (**never auto-pick** — Gary's call). Add
  `POST /api/sessions/:id/artifacts/:artifactId/resolve` — write-back **against the conflict
  seq** (verify path); `latest` advances to a `normal` version.
- **Conflict-aware serve (#5):** `by-path` serves the last `status='normal'` version + a
  `conflicted` flag + the conflict seq; marker bytes only via an explicit inspect endpoint;
  a write whose base = a conflict seq is a *resolution*, not a blind new version (no silent clear).
- **A3 UX (web):** `ChangesSurface`/Work drawer renders `status=conflict` as a both-sides diff
  (the `conflict` jsonb's left/right label/author/sha); resolve = one edit; human banner; agent
  steer hook. Version-skew labels (#14): `/atrium/artifacts` vs `/workspace` seq badges.
- **A4 scope query:** `GET /api/sessions/:id/hydration-scope` → the path set this session
  subscribes (workspace/topic/path-prefix per §10.1); pairs with C-hydrate.

**Tests:** server (resolve advances to normal; delete-vs-edit→conflict; conflict-aware serve
hides markers; base=conflict-seq = resolution not new-version); web RTL (both-sides diff,
resolve action, banner, skew badge); Playwright e2e (two-actor concurrent edit → conflict →
resolve → converge).

**§8B issues closed:** #5 (conflict reads/markers), #14 (version skew); delete-vs-edit product call.

---

## Phase 3 — A: unified Files surface (polymorphic git + ledger)  (§2 decision; in scope)

- **Server:** a **git-backed file source** for the session's repo/branch (mig `030`
  `session_repo_branch` exists): list tree, read blob, **commit** (branch-aware write-back).
  A polymorphic resolver routes `(path)` to **git** (repo files) or **ledger** (artifact ns)
  by location-as-backing (§2 — no dual-store).
- **Web:** one Files/gallery/editor over both backings — preview + edit; history from git
  (repo) or the ledger (artifacts); edit-repo-file = git commit, edit-artifact = ledger
  write-back. Aligns daily-driver §3 "one Files abstraction."

**Tests:** server (git source read/commit; polymorphic resolve picks the right backing); web
RTL (renders both backings, correct write-back path per file); e2e (edit a repo `.md` → git
commit; edit an artifact → ledger version).

---

## Phase 4 — C4: overlay provisioning + node-scan capture (outbound)  (closes #1, #3-write, #12, #16, #19, #20)

Base off `gb/api-rs-artifact-capture`. The in-container poll is **retired** (kept as a fallback flag).

- **Overlay provisioning** (privileged init/controller, NOT the agent): `lowerdir` (RO) =
  base + deps + repo (`clone --shared`, RO) + hydrated artifacts; `upper`+`work` =
  session-keyed persistent node vol (`/var/lib/centaur/overlays/<session>/…`, Local PV);
  `metacopy=off`. Setup mounts `mountPropagation: Bidirectional`; agent mounts `/workspace`
  `HostToContainer` (k8s forbids Bidirectional on non-privileged). **Structural scoping** —
  overlay = artifact ns only; repos/deps/caches/scratch are separate vols (§2). Manifests in
  `contrib/chart`. Unmount-on-teardown.
- **Node DaemonSet** (privileged, O(nodes)): pod informer → scan each `upper` (O(changes));
  interpret overlay encoding (regular→created/modified; char 0/0→delete;
  `trusted.overlay.redirect`→rename, else delete/create fallback #16; `opaque`); **openat2(
  RESOLVE_NO_SYMLINKS|NO_MAGICLINKS|BENEATH|NO_XDEV)** fresh per component (#1, symlinks as
  metadata only); **torn-read gate** — changed-during-read re-read + `/proc/<pid>/fd` skip
  (#3); **base-aware capture** — pass the hydrated `base_seq` per path from the manifest (#2);
  route large/append-heavy files out of the overlay ns (#12); POST **direct to Atrium S3**
  with **streaming multipart + size caps + per-node concurrency** (#20, large-file path);
  attribute session via annotations. Narrow scanner IAM to session/tenant prefixes +
  seccomp/AppArmor; split setup-privilege from steady-state scan (#19).

**Tests:** Rust unit (overlay-encoding interpreter; openat2 symlink-skip → ELOOP; torn-read
re-read; large-file routing); a **privileged-Linux integration test** re-running the 9/9 kernel
POC as CI (create→upper, modify→copy-up, delete→whiteout, rename, non-root-agent-write→node-read);
kind e2e (provision overlay → agent writes `/workspace/proj-x/a.md` → node-scan → POST →
Atrium ledger version appears via the by-path route).

**§8B issues closed:** #1 (symlink escape), #3-write-side, #12 (metacopy amplification),
#16 (rename fidelity), #19 (DaemonSet TCB), #20 (large-file multipart).

---

## Phase 5 — C-hydrate: hydration manifest + lower materialization + subscription set  (closes #10, #17, #18)

- **At startup:** resolve scope (A4) → **hydration manifest** (`path → version/base_seq`) —
  the linchpin both base-aware capture (#2) and adopt-time diff3 need. Materialize the artifact
  `lower` from the ledger: **tree-manifest (1 GET) + node-local CAS cache + reflink** (#10
  cold-start stampede; #18 reflink FS — require XFS/btrfs at admission, FICLONE probe, refuse
  ext4, blobs immutable `0444`, no hardlink fallback). **Subscription set** = the paths the
  node polls A1 for. Lower-stability across pause/resume (#17): Local PV + required nodeAffinity
  + `WaitForFirstConsumer` + app-level manifest/hash check (fail-closed on mismatch).
- **Atomic multi-file (#13):** commit-group / tree-manifest snapshot at a quiesce checkpoint;
  hydrate by snapshot id, not per-path latest.

**Tests:** Rust (manifest build from scope; lower materialize byte-correct vs ledger; reflink
probe refuses ext4; hash-mismatch fail-closed); kind e2e (hydrate lower → agent reads correct
base bytes; resume reattaches the same upper over an identical lower).

**§8B issues closed:** #10 (cold-start), #13 (atomic multi-file), #17 (resume affinity), #18 (reflink FS).

---

## Phase 6 — C-merge: node-side inbound merge + C-quiesce  (closes #3-race, #15; validates the inverse linchpin)

- Node polls A1's feed for hydrated paths; fetch `theirs`; maintain per-path state
  `{base_seq, base_sha, upper_sha, applied_remote_seq}` (#2). Run the **3 cases**:
  unedited→write; edited→`diff3(base, ours, theirs)` clean→write / conflict→markers + ledger
  `status=conflict`; **resurrect** (whiteout vs remote edit → delete-vs-edit conflict per the
  decision)→write. **Write through `merged`** + set agent ownership (`uid-1001`,`664`) +
  **atomic temp+`rename()`** (#3; in-place O_TRUNC ≈ 74% torn reads, POC); per-path
  **write-lease** + harness **between-steps quiesce signal** + `/proc/<pid>/fd` gate (#3,
  invisible to the model). Echo suppression via per-path state (#2). **Process-level
  invalidation** on adopt — signal reopen/restart so open FDs/watchers don't hide the write (#15).

**Tests:** Rust (3-case adopter; diff3 clean vs conflict; resurrect→conflict; temp+rename = 0
torn vs O_TRUNC ~74%; echo suppression; base advance after clean adopt); kind e2e (**the
C-verify residual**: node-writes-`merged` → agent-reads — the inverse of the proven case; two
containers editing one artifact → live convergence within seconds; conflict recorded, not lost).

**§8B issues closed:** #3-race-side, #15 (FD/watcher invalidation).

---

## Phase 7 — C-project + durability extensions  (closes #4, #6, #8, #9, #11)

- **`/atrium` projection (#4, #6):** node maintains the RO context tree —
  `chat/<ch>/<thread>.md` = debounced **re-rendered current view** (edits/deletes/redactions
  applied) + `…events.jsonl` raw log (#6, no secret re-disclosure); sibling
  `sessions/<id>/transcript.jsonl` append-tail; `artifacts/<path>` latest view. **ACL (#4):**
  workspace-public slice shared per-node (reflinked) + a small **per-agent overlay** for
  private channels/DMs the session is a member of (honors `channel_members`/DM ACL). The
  `atrium search|read|log` tool for the wide cold tail.
- **WIP patch-artifact (§5A):** node captures uncommitted repo work as a **pure-read** `git
  diff HEAD` + untracked snapshot → ledger blob; **zero git refs/objects** in the shared repo.
  Recovery = re-clone @ base_HEAD_sha + `git apply` + drop untracked.
- **Logs/transcripts:** chunked CAS blob + append-index (feeds resume, not the gallery).
- **Atomicity/GC/backpressure:** upload↔commit (`pending_blob` + verify HEAD then advance
  latest, #9); GC normalizes all blob refs incl. conflict-side shas, honors unresolved
  conflicts + leases + outbox lag (#8); per-session dirty-byte budget + scan-lag metric +
  harness backpressure before ENOSPC + bounded upload queue (#11). Packing (≤64–128 MB
  pack files + `sha→(pack,offset,len)` index) when CDC is un-deferred (type-gated).

**Tests:** Rust/integration (chat current-view re-render hides a redaction; per-agent ACL keeps
a non-member from a private thread; WIP patch round-trips via re-clone+apply with no refs
created; GC spares conflict-side blobs + leased + outbox-lagged; upload-crash leaves no
readable orphan; dirty-byte budget pauses before ENOSPC).

**§8B issues closed:** #4 (/atrium ACL), #6 (chat projection), #8 (GC vs conflict blobs),
#9 (upload↔commit atomicity), #11 (backpressure).

---

## Phase 8 — V: the linchpin + 20-issue matrix + full e2e

- **The lone residual gate:** `mountPropagation: Bidirectional` (setup) → `HostToContainer`
  (agent) on a multi-process node, and the **inverse write** (node-writes-`merged` →
  agent-reads). Run in kind as far as the Mac/linuxkit allows; document any
  arm64/linuxkit quirk vs the prod ext4/xfs Local-PV expectation.
- **20-issue verification matrix:** each §8B item re-checked as an automated assertion where
  possible (the POC checks become regression tests).
- **Full e2e:** two agents + a human editing one shared artifact live → capture → conflict →
  resolve → all converge; WIP recovery; pause/resume lower-stability (#17).
- **Multi-tenant/VM (#19):** documented + gated future (daily-driver is single-tenant).

**Exit:** the design is implemented end-to-end with every §8B issue closed by code + a test,
and the inbound→capture→conflict→resolve loop runs green in kind.

---

## Test strategy (cross-cutting)

| Layer | Tooling | Where |
|---|---|---|
| Atrium server (SQL/ledger/feed/resolve) | vitest + live PG `:5433` + `FakeStorage`/MinIO | `surface/server/test/*.test.ts` |
| Atrium web (conflict UX, Files surface) | vitest + RTL | `surface/web/test/*.test.tsx` |
| Atrium e2e (two-actor conflict, Files) | Playwright | `surface/e2e` |
| Centaur node logic (overlay/scan/merge) | `cargo test` unit + privileged-Linux integration | `services/api-rs/crates/*` |
| Centaur capture (Python fallback) | pytest | `services/sandbox/tests` |
| k8s wiring + linchpin + full e2e | kind cluster + scripted POCs-as-tests | `services/api-rs/crates/centaur-sandbox-e2e`, `contrib/chart` |

**Sequencing:** A1→A2/A3/A4→A-Files can run start-to-finish on Atrium with no Centaur dep
(lands the human/in-app loop first). Centaur C4→C-hydrate→C-merge→C-project is gated on the
kind cluster; C-project is independent (append-tail). Validation (Phase 8) folds the POC
checks into regression tests as each Centaur phase lands.

## Build mechanism

Claude orchestrates (plan, review diffs firsthand on cross-branch seams per
`self-review-before-codex`, QA, merge). Parallelizable Atrium lanes (A1 / A3 / A-Files) and
independent Centaur lanes fan out to codex/subagents in worktrees per `codex-delegation-pattern`
**when the runtime is healthy**; otherwise Claude-direct. Every lane is merged only behind a
green suite + a firsthand diff review.
