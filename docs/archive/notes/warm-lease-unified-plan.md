# Warm-lease unified plan — warm pods + harden Medium

> **Status: PLAN, stress-tested and code-reconciled (2026-06-30).** An earlier draft of this doc sequenced toward
> a **working-set snapshot → Full per-repo pool**. That thesis was **disproven by POCs** (see
> §4) — the snapshot loses to the already-shipped Medium tier for both pnpm and cargo. This
> revision keeps only what survived: **finish the warm-pod work (#141) and harden the Medium
> cache keying.** Do **not** re-propose working-set snapshots without new evidence — read §4 first.
>
> **Decisions locked with Gary:** build portable (single-box OVH → scales); cargo cross-node
> reuse eventually goes through **shared sccache**, not raw `target/`; node_modules snapshot
> **cut after measurement**; Full per-repo pool **dropped**. On the current single-node OVH
> deployment, node-local depcache/sccache are already shared by all sessions, so shared sccache is
> a future multi-node task, not a blocker for the near-term warm-pod work.

## 0. Where we are (shipped on `master`)

- **Medium content-keyed dep/build cache** — node depcache (pnpm store / cargo registry / uv)
  + sccache + a cross-node Atrium-CAS tier keyed by lockfile hash. Hydrate via
  `warmcache-hydrate` init container, capture via the node-sync daemon, bounded by
  TTL/size-cap + node LRU. (`warmcache.rs`, `cas.rs`, mig `051_warmcache_blobs.sql`.)
- **Warm pool of generic pods** keyed by a single `workload_key` (harness/persona),
  repo-agnostic (`centaur-sandbox-manager/src/warm_pool.rs`).
- **#141 v1 — repo-bearing warm sessions** (`052b7503`): org-default repos compose under
  `~/repos/<owner>/<repo>`; multi-repo `session_repos` spec (mig `056`); the **post-claim bind
  primitive is already built**. `prepare_claimed_overlay_home`, the helper pod, readiness wait,
  `session_repos` claim-filter relaxation, and retire-then-cold-spawn fallback are present and
  covered by targeted Rust tests. **Open:** the post-claim HOME that gets bound is incomplete:
  it does not yet compose the warm pod's generic harness HOME as a lower, and the `/home/agent/context`
  child mount is hidden by the HOME submount.

## 1. The cold-start ladder, and what's left

`ATRIUM_FORK.md` "Sandbox warming" decomposes a cold start into ~5 serial costs. After the
POCs, here is the honest accounting of what each costs and what closes it:

| Cold-start cost | Warm baseline today | Gap left |
|---|---|---|
| Pod schedule + container start | warm pool can claim repo-bearing public/default sessions via post-claim bind | **Phase A** — finish HOME composition and context handling so claimed repo sessions are usable |
| Image pull | fat pre-baked image | — |
| Repo clone | node repo-cache mirror + `git clone --shared` | — |
| Dependency install | warm pnpm store → `pnpm install --offline` ≈ **4.6s** (measured) | already near-optimal — see §4 |
| Build / compile | node-local sccache + cargo registry | **Phase B** — toolchain-aware cache keys now; shared sccache later for multi-node |

**The key realization from the stress-test:** the dependency-install and build-compile rungs
are *already* largely paid down by Medium (warm store + sccache). The one rung Medium cannot
touch is **pod schedule/start for an arbitrary repo** — that's Phase A. Everything else is
hardening, not a new lane.

## 2. Plan

### Phase A — finish #141 post-claim HOME composition  *(the real remaining win)*
Let an explicit working/session repo claim a **generic** warm pod and receive a complete
flat-home overlay after claim. The bind primitive is shipped; the remaining work is what gets
mounted at `/home/agent`.

**A0 — keep the shipped primitive intact**
- Do not rebuild the post-claim bind machinery. `prepare_claimed_overlay_home`, helper pod,
  manifest rewrite, readiness wait, claim-filter relaxation, and retire/cold fallback are already
  present.
- Keep current eligibility unless deliberately expanded: public/default-capability sessions may
  warm-claim; private repos, custom env, persona-specific sessions, non-default capabilities, and
  resume-thread restore still cold-create.
- Keep the existing post-claim safety behavior: readiness handshake before first turn; on bind or
  compose failure **retire the pod and cold-spawn** (never serve a half-bound pod).

**A1 — generic HOME lower**
- Capture or stage the generic warm HOME as a read-only lower before the post-claim HOME overlay
  is mounted. It must include the harness config and prompt written by the warm pod entrypoint:
  `~/.codex`, `~/.claude`, `~/.config/amp`, `~/AGENTS.md`, and equivalent harness files.
- Compose that lower above the repo lower:
  `lowerdir=<generic-home>:<repo-or-composed-repos>`. The generic HOME snapshot carries the
  harness config/prompt; the repo lower carries `repos/<owner>/<repo>` plus repo files.
- Preserve today's flat-home prompt precedence: Centaur's top-level `~/AGENTS.md` wins over a
  repo top-level prompt, while nested repo prompts still live under `~/repos/...`.
- Use the existing node-sync `extra_lower`/multi-lower mount path where possible instead of
  inventing a new mount planner.

**A2 — context under the HOME submount**
- Preserve `/home/agent/context` after the HOME submount. A kind POC confirmed that the
  existing context child mount is hidden when the post-claim overlay is mounted at `/home/agent`.
  The implementation needs an explicit context rebind/remount strategy or a deliberate path change;
  do not ship warm-claimed repo sessions without resolving this.

**A3 — tests and smoke**
- Unit-test the generic-HOME lower planning, lowerdir order, helper manifest arguments, and
  failure fallback.
- Add/run a real-pod kind e2e that starts a generic warm pod, post-claim mounts the composed HOME,
  proves harness config + repo files are visible, proves writable upper capture, and proves
  `/home/agent/context` is readable after the submount.
- After kind passes, run a watched real-model smoke through a warm-claimed repo session. This spends
  real model tokens and is not a normal unit/PR check.

**Exit:** public repo sessions claim a warm pod and see a complete flat HOME: harness config,
repo files, Centaur prompt precedence, writable upper, and readable `/home/agent/context`.
Real-pod kind e2e green, followed by a watched real-model smoke.

### Phase B — harden Medium cache keying  *(near-term cache work)*
Do this after or alongside Phase A if the code is naturally nearby. This is small hygiene; it is
not a new cache lane.
- **Add toolchain identity to the warmcache key** — today the key is
  `(workspace_id, lockfile_hash, kind)` with no toolchain component; a node image/toolchain bump can
  reuse a store hashed under the old toolchain (`warmcache.rs:35,140`).
- Include the dimensions that can change store compatibility: pnpm major/store layout
  (`STORE_VERSION` when available), Node major, rustc version for cargo-related stores,
  OS/libc/arch, and preferably the sandbox image/toolchain digest if available.
- **Pin and document toolchain assumptions** across the warm pool. The key protects correctness;
  pinning protects hit rate.
- **Exit:** no silent cache poisoning on toolchain drift; cache misses are explainable when the
  image/toolchain changes.

### Phase C — multi-node cache work  *(future, not current OVH blocker)*
- **Shared sccache backend on Atrium CAS or object storage** + `CARGO_INCREMENTAL=0`. This is the
  canonical machine-portable cross-node cargo cache (content-hash keyed; immune to the mtime/path
  coupling that sank raw-`target/` snapshots — §4).
- Do not prioritize this while deployment is a single OVH node: node-local sccache is already
  shared across sessions on that node. Revisit when sessions can schedule onto multiple nodes or
  node-local cache misses show up in metrics.
- **Exit:** cross-node cargo reuse without raw `target/` snapshots.

### Phase D — optional product polish / adjacent cleanup
- Remove leftover `~/github` assumptions in sandbox scripts/images if they still exist
  (`git-branch.sh`, `entrypoint.sh`, Dockerfile/tool-shim residue). This is mechanical and should
  stay separate if it starts touching behavior.
- Surface/UI work for org-default available repos and warm-pool status is useful product polish,
  but it is not required for the Phase A correctness path.

### Dropped
- **Working-set snapshot (node_modules / `target/`)** — disproven, §4.
- **Full per-repo pool** — its mechanism was snapshot pre-staging; with snapshots gone, it
  reduces to "keep N idle pods per repo," whose marginal value over Medium doesn't justify the
  idle-pod + storage cost. If ever revisited, do it as **same-node session affinity / keep-warm
  for the 1–2 hottest repos**, not working-set snapshots.
- **Private repo warm-claim in this cut** — still cold-create. Private repos need
  principal-scoped hydrate through iron-proxy/git CA before they are safe to claim into a generic
  warm pod.

## 3. Where Medium *doesn't* help (accepted residuals)
- **First spawn of a repo/commit** — nothing is warm yet; pay the cold path once.
- **Dependency churn** — a lockfile bump re-downloads the changed slice (store handles the rest).
- **Cross-OS/arch** — native deps (esbuild/swc/rollup; cargo host artifacts) are arch-locked;
  the pool must be single-arch (it is).
- **Cold node** — store/sccache must be pulled from Atrium CAS over the network the first time.

## 4. Stress-test findings — the snapshot thesis, DISPROVEN (do not re-propose)

POCs run 2026-06-29/30 in a privileged Linux container (Docker, btrfs/xfs loopback, real
pnpm install + cargo build). Scripts: `scratchpad/{snapshot-spike2,cost3b,poc-mtime-buildrs,poc-mtime2,poc-pnpm-link}.sh`.

**Premise that held:** a built tree *can* relocate at a stable container path — flat-home
guarantees `/home/agent/...` across pods (cargo recompiled 0/11 with mtimes preserved). So the
idea wasn't crazy. It died on **economics and mechanism**, not feasibility.

**pnpm node_modules snapshot — measured slower than Medium, and breaks dedup:**
- Cold install **30.0s** → warm-store `pnpm install --offline` link step **4.6s** (23k files,
  538 MB). Medium already captures that 85% win.
- Snapshot restore + mandatory verify = **6.5s** — *slower* than the 4.6s link step (pnpm
  linking is just hardlink creation; nothing beats it). The no-op verify alone is 1.8s and
  can't be skipped.
- A node_modules-only snapshot **breaks store hardlink dedup**: store (535 MB) + restored
  node_modules (537 MB) = **1.1 GB** real disk vs ~535 MB linked. Preserving dedup means
  shipping the store too — which Medium already does.
- **Verdict: no scenario where it wins.**

**cargo `target/` snapshot — fragile and redundant with sccache:**
- Cargo freshness is **mtime-based** (primary source: cargo fingerprint module). A
  content-addressed restore scatters mtimes → workspace crates spuriously recompile (POC:
  `compiled=1`). Registry/git deps are excluded from dep-info mtime checks, so they *stay*
  fresh — i.e. the expensive layer is already cached by the registry store + sccache, and the
  snapshot only "saves" the cheap workspace relink while adding mtime/path/host coupling.
- `-Z checksum-freshness` exists but is **nightly-only** (still mtimes for build-script inputs).
- The canonical industry pattern (`Swatinem/rust-cache`, Mozilla sccache) **deliberately does
  not** snapshot raw `target/` cross-machine.
- Capture cost (real 20.8k-file tree): btrfs subvol snapshot **0.28s O(1)**, reflink ~per-file
  (~13s for a 114k-file tree), tar ~19s. `target/` is **11 GB and churns every commit** → poor
  dedup, storage blowup.
- **Verdict: use shared sccache instead.**

**Other side-effects that would have bitten a snapshot lane:** content-addressed CAS drops
hardlinks/symlinks (breaks pnpm); 114k-file trees blow the warmcache per-file manifest 100k cap
(would need the artifact streaming path); snapshots carry built artifacts across sessions (must
stay workspace-scoped to avoid cross-tenant leak); toolchain drift not in the cache key.

## 5. Validation record and open / ops items
- **Code reconciliation (2026-06-30):** verified the post-claim bind primitive exists in
  `centaur-session-runtime`, `centaur-sandbox-manager`, `centaur-sandbox-agent-k8s`, and
  `centaur-sandbox-core`. Targeted tests passed for warm repo claim, private repo cold fallback,
  post-claim failure cold fallback, helper-pod manifest/readiness, flat-home context mount rendering,
  multi-repo lower planning, and the existing `extra_lower` lowerdir hook.
- **HOME composition POC (kind, 2026-06-30):** `warmpool-home-compose-poc.sh` passed with a
  running pod: generic HOME config + repo files both visible, Centaur `AGENTS.md` wins, and writes
  land in the overlay upper.
- **Context shadow POC (kind, 2026-06-30):** a child mount at `/home/agent/context` is hidden after
  post-claim mounting a new overlay at `/home/agent`. This is a real implementation requirement,
  not just a theoretical concern.
- **Node filesystem** — confirm prod/OVH node FS supports reflink (xfs/btrfs); the existing CAS
  reflink path already falls back to copy, so this only affects speed, not correctness.
- **Toolchain pinning** — make pnpm/Node/rustc/arch uniform across the pool (Phase B).

## 6. POC reproduction
`docker run --rm --privileged -v "$PWD":/out rust:1-bookworm bash /out/<script>` over the
scripts in `scratchpad/`. npm registry is reachable from the container; crates.io is not (std-
only workspaces exercise cargo freshness offline; the pnpm POC uses real packages).
