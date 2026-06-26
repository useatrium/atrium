# Warm-cache tier (Phase 2.2) — design + decisions

> 2026-06-25. Builds on warm-lease Phase 1 (node-local depcache + sccache, LIVE) and
> Phase 2.1 (Atrium `warmcache_blobs` CAS store + `/api/internal/cache/*` routes, LANDED
> #124). Goal: make the dep/compile cache **cross-node + durable** via Atrium CAS, keyed
> by lockfile-hash, so a cold node reaches warm in single-digit seconds. This doc is
> written to be **stress-tested before any code** (the original 5B-4 overlay-lower framing
> has a load-bearing flaw — see §2).

## STRESS-TEST VERDICTS (2026-06-25, POC-confirmed)
| Claim | Verdict | Evidence |
|---|---|---|
| C1 pnpm store relocatable + `install --offline` | **PASS** | `pnpm install --offline` from a store copied to a new path + fresh HOME built `node_modules` |
| C2 cargo registry relocatable + `build --offline` | **PASS** | `cargo build --offline` from a relocated `CARGO_HOME` succeeded |
| C3 Option Y sidesteps symlink/relocatability | **CONFIRMED** | we ship the store; pnpm rebuilt the symlink-farm `node_modules` locally, offline |
| C4 grain (per-file vs tar-per-store) | **REVISED → per-package** | express+ts store = 767 files / ~50 pkgs; cargo = 335 files / 2 `.crate`s. one-tar-per-store = no dedup; per-file = object-count tracks file-count. **Per-package** dedups across lockfiles + scales with package count |
| C5 `git show <ref>:<lockfile>` pre-mount hash | **PASS** | distinct real hashes per ref from a bare cache, no checkout (resolve the right ref name) |
| C6 needs the overlay node-sync daemon? | **NO** | Option Y hydrates Phase-1's depcache **hostPath**, not the overlay lower |

**Net re-scope:** Phase 2.2 is **NOT** a deep node-sync overlay change. It's a standalone,
node-level **depcache hydrator** keyed by `(workspace, lockfile_hash, kind)`: on miss, pull
the store from Atrium CAS into Phase-1's `/var/lib/centaur/depcache/<kind>`; capture it back
post-install. Ship relocatable **stores** (pnpm store, cargo `~/.cargo/registry` incl. the
native `.crate` files, sccache, uv) at **per-package grain**. Overlay daemon untouched.
See §8 for the recommended shape; §2 Option X (overlay lower) is **rejected**.

## 0. Flow facts (grounded, file:line)
- Hydration runs **at overlay compose time, first-mount only, BEFORE mount**:
  `centaur-node-syncd.rs:430` → `hydrate_artifact_lower_into_plan` (`cas.rs:176`), then
  `mount_overlay` (`overlay_mount.rs:291`).
- At hydration time the daemon **can read the repo-cache** (`/var/lib/centaur/repos/<org>/<repo>`,
  via `plan.repo_cache_root` + `plan.repo_mounts`) but **cannot** read `/workspace` (not mounted).
- Repo ref: the session manifest carries `RepoMount { repo, ref, subdir }`; the repo-cache
  may sit at a different HEAD than the session ref → **read the lockfile at the exact ref
  with `git show <ref>:<lockfile>` from the cache**, not the cache working tree.
- Overlay path mapping is **direct** (`artifact-lower/shared/x` → `/workspace/shared/x`);
  multi-repo composes repos at `lower/<subdir>/…`.
- Capture is periodic (`outbound()` ~2s) → `capture_sweep` (`runtime.rs:421`) over the
  **upper**; classifier `partition_entries_by_lane` (Artifact/HarnessState/Denied); repo
  subdirs are **denied** today. `AtriumClient` HTTP impl in `http_client.rs` (mirror
  `hydration_scope`/`post_capture` for the cache routes).

## 1. What we cache (DECISION) — stores, not installed trees
Ship the **relocatable download/compile caches**, never the installed/built trees:
| Ship (relocatable, content-addressed) | Do NOT ship |
|---|---|
| pnpm store (`<store>/v3/...`) | `node_modules/` (pnpm symlink farm → `.pnpm`) |
| `~/.cargo/registry` + `~/.cargo/git` | cargo `target/` (non-relocatable — use sccache) |
| sccache object dir | — |
| uv cache, go mod cache | — |
This is the **same split Phase 1 made** (entrypoint redirects pnpm `store-dir` / `CARGO_HOME`
registry / `SCCACHE_DIR` / `UV_CACHE_DIR` at the node depcache). The agent's `pnpm install`
then resolves from the warm store with **no network** and builds `node_modules` locally
(fast, deterministic). Avoids the symlink-farm + absolute-path relocatability traps.

## 2. The architecture fork — Option X vs Option Y
**Option X — overlay lower (original 5B-4).** Hydrate cache blobs into a `warmcache_lower`,
stack it in the overlay `lowerdir` so the agent sees a pre-populated tree. **Problems:** the
thing worth caching is the *store* (a node-level dir at `/var/cache/centaur/depcache`,
Phase 1), NOT a per-session workspace path — so an overlay *lower* (which surfaces under
`/workspace`) is the wrong mount point. Forces per-session duplication of a node-shared
cache; tangles with multi-repo subdir namespacing; tempts shipping `node_modules`.

**Option Y — hydrate the Phase-1 node depcache from CAS (RECOMMENDED).** Phase 1 already
bind-mounts a node-local `/var/lib/centaur/depcache` (shared across pods on the node) into
every sandbox. Phase 2 = **populate + persist that dir via Atrium CAS**:
- **Hydrate (cold node):** before a session that needs deps, if the node depcache lacks the
  store for this `(workspace, lockfile_hash, kind)`, pull the store blobs from Atrium CAS
  (`GET /cache/hydration` + `GET /cache/blob`) and **reflink** them into the depcache dir.
- **Capture (after install):** the agent's `pnpm install`/`cargo fetch` populate the depcache
  store; capture the new store entries back to CAS (`PUT /cache/blob` + `PUT /cache/manifest`)
  keyed by the lockfile-hash.
- **No overlay lower for the cache.** Reuses Phase 1's mount; cross-node durability is the
  only new capability. Simpler, store-relocatable, node-shared by construction.

**Recommendation: Option Y.** It matches Phase 1's "ship the store" decision and sidesteps
overlay path-mapping/symlink/relocatability. The overlay daemon's `hydrate_*_lower` is NOT
the right hook — hydration targets the node depcache dir, which is a node concern, runnable
from the node daemon (it already runs per-node) or a small per-pod init step.

## 3. Lockfile-hash keying
- `kind` ∈ {pnpm, npm, cargo, uv, go} (start pnpm + cargo — in the image, highest impact).
- key = `sha256(git show <ref>:<lockfile>)` per repo per kind, from the repo-cache.
- A cache entry = a manifest of store files for that `(workspace, lockfile_hash, kind)`.
- Cross-repo / cross-session reuse is automatic: same lockfile hash → same store blobs.

## 4. Contract (2.1 routes) — fit + one gap
2.1 landed workspace-scoped routes: `GET /cache/hydration?workspace_id&lockfile_hash&kind`,
`GET/PUT /cache/blob?sha256`, `PUT /cache/manifest`. Gap: **the daemon has the session id,
not the workspace id.** Resolve by either (a) the daemon reads `workspace_id` from the
session manifest / a session-resolve call, or (b) add session-scoped variants
(`/api/internal/sessions/:id/cache/...`) that resolve `workspace_id` server-side (consistent
with every other internal daemon route, which is session-scoped). **Lean (b).**

## 5. Capture / write-back (2.2b)
- Trigger: **on quiesce / checkpoint**, NOT every 2s (the store is large). Debounce.
- Read the depcache store dir (not the overlay upper — the store is node-local, outside the
  overlay), diff against the hydrated manifest (only new/changed store files), upload deltas.
- Register the manifest keyed by the **current** lockfile-hash (re-read post-install; the
  agent may have changed deps → a new hash → a new cache entry, leaving the base intact).
- Concurrency: multiple pods share the node depcache → capture must tolerate concurrent
  writers (content-addressed; last-writer-wins on the manifest pointer; the store files are
  immutable-by-sha).

## 6. Eviction
- Atrium: drop `warmcache_blobs` rows for `lockfile_hash` not hydrated in N days per
  workspace → un-roots blobs for the existing GC. Per-workspace size cap.
- Node depcache: LRU by store-dir size (Phase 1 already a rebuildable cache; bound it).

## 7. OPEN QUESTIONS — for the stress-test to hammer
1. **Relocatability:** is the pnpm store truly node-relocatable (content-addressed `v3/`)?
   cargo registry? Any absolute paths that break cross-node reuse? (POC: hydrate a store on
   node B from node A's blobs, run `pnpm install --offline`, assert 0 network + success.)
2. **Granularity / cost:** a pnpm store / cargo registry is tens of thousands of files.
   Manifest size (2.1 cap = 100k), reflink/hydrate syscall cost, capture diff cost. Is
   per-file CAS the right grain, or should we tar a store snapshot per lockfile-hash into
   ONE blob (1 GET, 1 untar) — far fewer objects, simpler manifest? **Likely tar-per-store.**
3. **Where hydration runs:** node daemon (per-node, already privileged) vs a per-pod init
   container vs the entrypoint. Option Y points away from the overlay daemon. Pick the owner.
4. **workspace_id resolution** (§4) — confirm the session-scoped route variant.
5. **`pnpm install --offline` determinism** given only the warm store (no lockfile drift).
6. **Does Option Y even need node-sync at all?** If hydration is "pull a tar into the node
   depcache dir keyed by lockfile-hash," it may be a small standalone node component, not a
   change to the overlay daemon. Re-scope accordingly.

## 8. Recommended shape (stress-test-validated)
A node-level **depcache hydrator** (a small standalone component — NOT the overlay daemon):
- **Hydrate (on miss):** keyed by `(workspace, lockfile_hash, kind)` — read the lockfile at
  the session ref via `git show` from the repo-cache (C5), hash it, and if the node depcache
  lacks that key, pull the store from Atrium CAS and reflink into
  `/var/lib/centaur/depcache/<kind>` (Phase-1's hostPath, already mounted into every pod).
- **Grain = per-package** (C4): pnpm → one blob per store package dir; cargo → the native
  per-crate `.crate` files in `registry/cache` (+ the index). Dedups across lockfiles,
  object count tracks packages (low thousands even for big monorepos), fast hydration.
- **Capture (post-install, on quiesce):** diff the depcache store against the hydrated
  manifest, upload new per-package blobs (`PUT /cache/blob`), register the manifest
  (`PUT /cache/manifest`) under the current lockfile-hash. Concurrent pods on a node share
  the depcache → content-addressed, last-writer-wins on the manifest pointer.
- **Owner / placement:** the node already runs a privileged daemon per node; the hydrator
  can be a module there OR a per-pod init step. Since hydration must precede the agent's
  install and needs the repo-cache + the node depcache (both node-local), a **node-daemon
  module** is the natural owner — but it touches NONE of the overlay lower/upper machinery.
- **Sub-decomposition (revised):** 2.2a = Atrium `/cache/*` already done (2.1) + the
  session-scoped route variant (§4) · 2.2b = the node hydrator (read path, per-package) ·
  2.2c = capture (write-back) · 2.2d = a real-image `pnpm/cargo --offline` e2e (provable on
  the Mac via `docker run` against the sandbox image — NO kind needed, since there's no
  overlay). The cluster-gating largely **evaporates** with Option Y.

## 9. Resolved open questions
- Q1 relocatability → PASS (C1/C2). Q2 grain → per-package (C4). Q3 owner → node-daemon
  module, overlay untouched (C6). Q4 workspace_id → §4 (session-scoped route). Q5 offline
  determinism → PASS (C1). Q6 needs overlay daemon → NO (C6).
- **Newly surfaced:** ship cargo's `.crate` files (registry/cache) NOT `target/` (matches
  Phase-1 sccache split); sccache objects are already content-addressed → ship as-is.
