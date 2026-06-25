# Warm-lease build plan — deps + build caching for agent sandboxes

> **Status: BUILD PLAN (2026-06-25).** Decision locked with Gary: **ship Medium
> (content-keyed warm-cache tier) first; Full (per-repo warm pool) is an optional
> future enhancement, not v1.** Goal = "warm the whole lease": pod + checkout +
> deps + build cache, so a spawned agent is productive in **seconds, not minutes**.
> Scope = a few known hot repos to start; keying designed multi-tenant-safe, shipped
> single-tenant first. Builds on the already-shipped overlay foundation
> ([[shared-workspace-build-spec]] 5B-1→5B-3) and the CAS ledger
> ([[cas-ledger-build-plan]], [[agent-data-architecture]]). Realizes the
> "warm the whole lease, not just the pod" call in `atrium-daily-driver-plan.md` §4/§5.

---

## 0. Where we are today (grounded against code, not assumed)

A cold session's startup decomposes into five serial costs. Centaur already pre-pays
1–3; the **dependency-install and build/compile costs (4) are still cold**, and the
Atrium spawn path doesn't even reach a repo (0).

| Stage | Status | Evidence |
|---|---|---|
| Pod boot / schedule / container-start | ✅ **warm pool**, on in prod (size 3, replenish 5s) | `centaur-sandbox-manager/src/warm_pool.rs`; `contrib/chart/values.yaml:285`; upstream `SandboxWarmPool` CRD (agent-sandbox subchart) |
| Image pull | ✅ fat pre-baked toolchain image (Rust/Node/Python/Bun/Foundry/agent CLIs) | `services/sandbox/Dockerfile` (`FROM ubuntu:24.04`) |
| Repo clone | ✅ node **repo-cache** (full mirror, 30s sync) + per-session `git clone --shared` | `contrib/chart/templates/repo-cache.yaml` (hostPath `/var/lib/centaur/repos`); `services/sandbox/entrypoint.sh`, `git-branch.sh` |
| **Dependency install** (pnpm/cargo fetch/uv) | ❌ **COLD** every session | only an `emptyDir` at `/home/agent/state` (`centaur-session-runtime/src/lib.rs:2687`); no dep-cache PVC |
| **Build / compile** (cargo build, tsc, next build) | ❌ **COLD** every session | no persisted `target/`/`node_modules`; `kache` is baked in the image but **wired into nothing** at runtime |

Two more load-bearing facts:

- **Atrium-spawned sessions never target a repo.** `surface/centaur-client/src/client.ts`
  sends only `harness_type` + metadata; repo/branch are captured at spawn for the
  Phase-4 UI surfaces and are **not forwarded to Centaur** (SpawnDialog comment:
  *"Centaur doesn't consume it yet"*; `surface/server/src/session-runs.ts` spawn call).
  Centaur *can* take repos via `AGENT_REPOS_JSON` env from session metadata
  `centaur_session_repos` (`centaur-session-runtime/src/lib.rs:59, 2032, 5280`), but
  Atrium never populates it. **So "warm the whole lease" is moot for Atrium until 0 is wired.**
- **The warm pool is repo-agnostic.** Its workload key is `(harness, persona)`; a claim
  *misses* on harness/persona mismatch and cold-creates
  (`record_sandbox_warm_pool_claim("harness_mismatch" | "persona_specific" | "miss")`,
  `centaur-session-runtime/src/lib.rs:1953`). It warms pod boot, never your repo or deps.
- **BuildKit `--mount=type=cache` in the Dockerfile is build-time only** — it speeds
  *image builds* and does not persist into the running container.

So: warm pods ✓, warm git objects ✓, warm toolchain ✓ — **warm deps/build ✗.** That gap is this plan.

---

## 1. The decision: Medium first, Full later

Medium and Full are **not alternatives — Full is built on top of Medium.** A per-repo
warm pool whose prebuilds compile from scratch is slow to replenish and expensive; it
only works well once a content cache exists underneath it.

| | **Medium — content-keyed cache (this plan)** | **Full — per-repo warm pool (future)** |
|---|---|---|
| Warms | deps + compile | everything incl. build |
| Latency result | minutes → **seconds** | seconds → sub-second |
| Repo coverage | **any** repo seen before (incl. arbitrary) | only enumerated hot repo×branch×harness×persona |
| Idle $ | **~zero** (storage only) | **high, multiplicative** (K idle pods/repo, 24/7) |
| Multi-tenant safety | safe by construction (content-addressed + tenant prefix) | per-tenant idle pools = the expensive/risky part |
| Staleness | self-invalidating (lockfile hash) | stale on every push → re-prebuild + agent still `git pull`s |
| Reuses shipped work | yes (overlay 5B-1→5B-3, CAS ledger) | net-new pool sizing + prebuild-on-push triggers |
| Reaper tension | none | direct (idle pods are what the 3h reaper kills) |

**Why Medium first:** it's the only option that's multi-tenant-safe by construction, has
~zero idle cost, covers arbitrary repos too, and reuses the overlay machinery already
shipped. Full is a per-repo *luxury layer* that buys the last few seconds for a handful
of hot repos at real idle cost — worth it only after Medium proves out. Industry
agrees: Coder/Daytona "claim-from-pool" (= Full) can only pre-bake identity-independent
work, so repo clone + install can't be baked unless you constrain to known repos
(combinatorial idle cost). See §9 for the full grounding.

---

## 2. The one technical landmine: compile cache ≠ shippable `target/`

Shipping raw `cargo target/` (or `.next/`) across machines is **fragile** — cargo
incremental caches are sensitive to absolute paths, mtimes, and compiler version;
cross-host reuse silently breaks. **Split the cache by kind:**

- **Dependency downloads** (pnpm store, `~/.cargo/registry`, uv cache, go modcache):
  ship the directory as a content blob — safe, big win.
- **Compiled output**: use **sccache** with a shared object backend (compiler-level,
  hash-keyed, relocatable, content-addressed — no RWX-volume locking). Do **not** ship
  `target/`. sccache is the load-bearing primitive for the Rust compile half.

The dominant safe sharing pattern is also already how our overlay is shaped:
**read-only shared lower + per-pod writable upper.** Never RWX-share a *writable*
`CARGO_HOME`/`~/.m2` across pods (corruption); mount caches RO, send writes to the upper.

---

## 3. Phases

### Phase 0 — wire repo/branch Atrium → Centaur (prerequisite, ~small)

Without this, Atrium sessions target no repo and nothing downstream matters.

- `surface/centaur-client`: extend `spawn()` to pass repo/branch (or set session
  metadata `centaur_session_repos`) so Centaur populates `AGENT_REPOS_JSON`.
- `surface/server/src/session-runs.ts`: thread the already-captured repo/branch from
  the spawn request into the Centaur call instead of dropping it after the DB write.
- Centaur entrypoint already checks out `AGENT_REPO`/`AGENT_REPOS_JSON` via
  `git clone --shared` off the node repo-cache — no Centaur change needed for the
  legacy path; the overlay path (5B-2) already selects repos from the manifest.
- **Acceptance:** an Atrium-spawned `@agent` with a repo lands in a checked-out working
  tree on the target branch, sourced from the node repo-cache (not a fresh GitHub clone).

### Phase 1 — Medium v1: shared cache mounts + sccache, single-tenant (~days)

The quick win, done overlay-safe (not the naive corruption-prone RWX share).

- **Node-local shared dep caches mounted RO into the overlay lower**, writes to the
  session upper: pnpm store, `~/.cargo/registry` + `~/.cargo/git`, uv cache, go modcache.
  Single-tenant = aggressive node hostPath (e.g. `/var/lib/centaur/depcache/<tool>`),
  trusted user, no isolation.
- **sccache** wired via `RUSTC_WRAPPER=sccache` + `SCCACHE_BUCKET` pointed at the
  existing **MinIO/S3** (same store the CAS ledger uses) — covers the Rust compile half
  across sessions/machines. Optionally `SCCACHE_DIR` node-local for v1 simplicity.
- Prime the caches once (build the hot repos) so the first real sessions hit warm.
- **Acceptance:** second session on a warm node runs `pnpm install` / `cargo build`
  in seconds (cache hits logged); measured against `sandbox_ready_duration_ms` +
  a new "time-to-first-productive-command" metric.

### Phase 2 — Medium v2: content-keyed warm-cache tier (5B-4), multi-tenant-safe (~weeks)

Hardens v1 into the designed tier and makes it tenant-safe + compile-reusable.

- **Content-address dep/build blobs in Atrium CAS**, keyed per §4; hydrate
  node-local → **reflink into the overlay lower** (`hydrate_lower`, already shipped for
  artifacts in 5B-3 — extend it to the warm-cache namespace).
- **Capture changed cache entries back to CAS at a checkpoint** (reuse the node-sync
  capture path; cache ns is daemon-written, never user-visible — keep it out of the
  Files surface/change-feed, same rule as the harness transcript in
  [[harness-resume-build-plan]]).
- **Gitpod-Classic-style working-set snapshot** for the hottest repos: snapshot the
  post-clone-post-install tree keyed by `repo+commit`, restore by nearest-ancestor
  commit + `git`-update the delta (attacks clone+install together for repeated repos).
- **Eviction:** LRU + per-tenant size cap on the node-local tier; CAS GC roots include
  live cache keys (extend the existing blob-GC).
- **Acceptance:** a cold node with empty local cache hydrates the warm working set from
  CAS and reaches productive in single-digit seconds; multi-tenant isolation holds
  (tenant A can't read tenant B's cache blob).

---

## 4. Cache-key scheme (multi-tenant-safe from day one)

Even in single-tenant v1, key with the full tuple so we never repaint:

```
depcache/<tenant>/<tool>/<lockfile-sha256>/<toolchain-version>
  e.g. depcache/acme/pnpm/<sha(pnpm-lock.yaml)>/node-24.x
       depcache/acme/cargo-registry/<sha(Cargo.lock)>/rust-1.xx
sccache: content-addressed by (compiler + preprocessed source + flags) — sccache owns this
worktree-snapshot/<tenant>/<repo>/<commit-sha>   (Phase 2 hot-repo snapshot)
```

- **Tenant prefix** = the isolation boundary; in single-tenant v1 it's a constant.
- **Lockfile hash** = automatic invalidation when deps change (no stale-cache bugs).
- **Toolchain version** in the key prevents ABI/format mismatches.
- Content-addressed everywhere → safe concurrent writers (last-writer-wins on the
  pointer), no shared-writable-volume corruption.

---

## 5. Two-tier hydration + capture flow

```
durable remote (Atrium CAS / GitHub)
        │  pull on demand (k8s nodes are ephemeral)
        ▼
node-local cache  (/var/lib/centaur/{repos,depcache,cas})   ← reflink source, shared across pods on the node
        │  reflink (≈free copy)
        ▼
overlay LOWER (read-only, composed: repo + warm caches)  +  overlay UPPER (session writes)
        │  at checkpoint
        ▼
capture changed cache entries → CAS  (next session/node reuses them)
```

- First session on a node pays the CAS pull; subsequent sessions on that node reflink
  for ≈free (matches the node-local CAS cache in `agent-sync-design.md`).
- The overlay daemon already does compose-lower → mount → capture-upper
  ([[c4-overlay-capture-build]]); Phase 2 adds the warm-cache namespace to the lower
  composition and the cache-capture path.
- **Critical (industry landmine):** the warm pod is claimed **generic**, then the
  daemon hydrates repo+cache **post-claim** via the overlay — never bake repo/cache
  into `spec.Env` or `VolumeClaimTemplates`, which would force a cold start on the
  `SandboxWarmPool` claim. (Today Centaur passes `AGENT_REPOS_JSON` as env — fine for
  the legacy clone path, but the cache hydration must go through the daemon/overlay.)

---

## 6. Single-tenant → multi-tenant migration

We ship single-tenant but never paint into a corner:

| Concern | Single-tenant v1 | Multi-tenant flip |
|---|---|---|
| Cache location | node hostPath, shared, trusted | same node tier, **tenant-prefixed keys** (already in §4) |
| Isolation | none (one user) | tenant prefix + per-tenant size cap; no cross-tenant blob reads |
| Poisoning | n/a | content-addressed + lockfile-keyed → a poisoned entry can't be silently trusted; sccache verifies inputs |
| Blast radius | n/a | per-tenant node/DaemonSet (VM-per-tenant model, [[agent-data-architecture]]) |

Because the key already carries `<tenant>`, the flip is policy (ACL on CAS prefix +
eviction caps), not a re-architecture.

---

## 7. Full — per-repo warm pool (OPTIONAL FUTURE, not v1)

Recorded so the door stays open; **do not build until Medium proves out.** Only for the
2–3 hottest repos, where "few known hot repos" bounds the idle cost.

- Extend `WarmPoolManager` workload key from `(harness, persona)` →
  `(harness, persona, repo, branch)` (`warm_pool.rs`).
- Prebuild = a pooled sandbox with repo checked out + deps installed + project built;
  replenish on git push (prebuild trigger, à la Codespaces/Gitpod/Coder).
- **With Phase 2's cache underneath**, prebuild/replenish is cache-hot and cheap → keep
  `K=1–2` and **cron-scale to zero overnight** (Coder pattern) to bound idle $.
- Accept: staleness-on-push (re-prebuild + agent fast-forwards to exact target), and the
  reaper tension (idle warm pods vs the 3h idle-stop sweep).
- **Lever that would make Full cheap:** Firecracker/CRIU **memory-snapshot** of a warmed
  base (E2B/Vercel/Modal model) — restore in tens of ms with ~zero idle running pods.
  Deprioritized (resume is file-based, we run k8s pods not microVMs —
  [[agent-session-resume-storage]]); flagged as the endgame if we ever move off plain pods.

---

## 8. Cross-cutting freebie (any time, orthogonal)

**Node image pre-pull / lazy-load** for the multi-GB agent image — kube-fledged or
SOCI / GKE Image Streaming. The research's "highest-ROI single win": kills image-pull on
cold nodes, ~zero idle cost, no per-session customization problem. Independent of the
cache work; do whenever convenient.

---

## 9. Industry grounding (condensed)

The five-cost framing and these analogs come from the 2026-06-25 landscape research:

- **Coder / Daytona claim-from-pool** = our Full. Confirms: pools pre-bake only
  identity-independent, parameter-fixed work → repo clone + install can't be baked
  unless repos are known (combinatorial idle cost). The `SandboxWarmPool` CRD we already
  use is `kubernetes-sigs/agent-sandbox`; **per-claim `spec.Env`/`VolumeClaimTemplates`
  defeats the warm hit** → pass repo/cache after claim (§5).
- **Gitpod Classic**: S3 `/workspace` snapshot keyed by repo+commit, nearest-ancestor
  reuse, restored by a privileged node daemon → the blueprint for §3 Phase 2's hot-repo
  worktree snapshot.
- **sccache → S3**: content-addressed, share-safe across ephemeral machines → the
  compile-cache answer (§2). Don't ship `target/`.
- **Safe shared-dep pattern**: RWX-mounted-**read-only** lower + per-pod writable upper;
  never RWX-share writable Maven/cargo. = our overlay shape.
- **Base-image baking + node image pre-pull + warm pod pool** = the repo-independent
  prefix; Centaur already has all three. The gap this plan fills is the **per-repo
  dep/build delta**.
- **Snapshot/restore (Firecracker/E2B/Modal/CRIU)**: highest ceiling, highest
  complexity, entropy/clock/network reseed required on restore → endgame only (§7).

---

## 10. Risks / open questions

- **Cargo `target/` reuse is a trap** — committed to sccache instead (§2). Validate
  sccache hit-rate on the hot Rust repos before relying on it.
- **Cache hydration on the critical path** — for a big repo the first CAS pull to a
  cold node could be seconds-to-tens-of-seconds; node-local reflink amortizes it.
  Hand-compute eager-vs-lazy hydration size caps (cf. `agent-sync-design.md` ~4s@10k /
  ~40s@50k files) before Phase 2.
- **Checkpoint timing for cache capture** — when does the daemon snapshot the cache
  back? (turn boundary? idle? explicit?) Reuse resume's checkpoint hook if possible.
- **Eviction policy** — LRU + size cap; confirm CAS blob-GC roots include live cache
  keys so we don't GC a hot cache.
- **Does Phase 1's node hostPath survive node recycling?** It's a cache (rebuildable),
  so eviction is fine; just measure the cold-node penalty.

---

## 11. Next step

**Phase 0** is the unblocker and is small: wire repo/branch through
`surface/centaur-client` + `surface/server/src/session-runs.ts` so Atrium sessions
actually target a repo. Everything else is downstream of that.
