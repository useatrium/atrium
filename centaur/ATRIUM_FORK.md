# Atrium's Centaur — how we work here

This started as a fork of `paradigmxyz/centaur`. It now lives **inside the Atrium repo**,
vendored at `centaur/` via `git subtree`. This is just **our Centaur** — but unlike before,
the Atrium repo (not a separate `gbasin/centaur`) is the source of truth.

> **Agents:** this file and the neighboring `AGENTS.md` auto-load whenever you work under
> `centaur/` (via `centaur/CLAUDE.md`). The Atrium repo root has its own `AGENTS.md`/`CLAUDE.md`
> for platform work and the repo-wide rules.

> When `AGENTS.md` in this directory says "the repo" / "repo root" / "clone this repo," it
> means **this `centaur/` subtree**, not the Atrium repo root.

## Source of truth & upstream
- **Source of truth:** the Atrium repo. There is no separate `gbasin/centaur` to push to
  (it's archived). Commit changes here like any other part of Atrium — a normal branch +
  PR into `master`.
- **Upstream:** `github.com/paradigmxyz/centaur`. We pull from it occasionally; we don't
  push back.
- **Pulling upstream (maintainer task, from the Atrium repo root):**
  ```bash
  scripts/centaur-sync.sh
  ```
  The script creates a sibling integration worktree from `origin/master`, adds/fetches
  `centaur-upstream` as needed, and runs the non-squash subtree pull there so the
  checkout you launched it from is not disturbed.
  - **Never `--squash`** — it silently drops our diverged edits with no conflict shown.
  - Conflicts land on the files we've changed (resolve keeping our edits). The `1000+`
    migration discipline below is what keeps DB migrations conflict-free across pulls.

> The branch model used to be `fork`/`origin` remotes on a standalone repo, with an
> `atrium/integration` branch rebuilt from topic branches. That's all retired — this is a
> subtree in the Atrium repo now. Nothing was lost in the change.

## What's here (the Atrium surface)
The substantive Atrium-only work this fork carries on top of upstream:

- **Artifact capture + workspace sync** — the node-sync capture/hydrate daemon ships overlay
  changes directly to Atrium's CAS ledger. Centaur no longer stages artifact bytes or
  exposes compatibility artifact byte routes.
- **Harness resume** — capture/restore of the rollout transcript so a torn-down session
  resumes the *same* Codex/Claude conversation (ephemeral home + entrypoint restore +
  conditional resume-trigger + a thread-scoped restore proxy).
  See `HARNESS_RESUME_SPEC.md` / `_REPORT.md` / `_E2E.md`.
  **Open:** the watched live-cluster e2e (deferred — it spends real model calls).
- **Claude SDK HITL bridge** — `services/sandbox/claude-sdk-bridge.mjs`: maps the Claude
  Agent SDK `AskUserQuestion` / `canUseTool` path to Atrium/Centaur `question_requested`
  frames and answers back, with defer/resume. Wired via the Dockerfile + `entrypoint.sh`;
  covered by harness-server tests (fake SDK).
  **Open:** the watched live-cluster e2e (real-SDK question round-trip).
- **Subscription auth** — per-execution Codex/Claude OAuth env injection.
- **Baked Atrium base prompt** — `services/sandbox/ATRIUM_BASE_PROMPT.md` is baked
  into the sandbox image at `/opt/centaur-overlay/services/sandbox/BASE_PROMPT.md`
  with `CENTAUR_OVERLAY_DIR` defaulting there, so Atrium sandboxes use the native
  identity, context, and artifact contract instead of the upstream base prompt.
  API-written `AGENTS_BASE.md` personas still take priority; external overlay deployments
  can override `CENTAUR_OVERLAY_DIR` and append their existing `SYSTEM_PROMPT.md`.
- **Warm-lease dep/build cache** — sandboxes reuse dependency + compile caches across
  sessions (upstream Centaur has none): a node-local depcache (pnpm store / cargo registry /
  uv) + sccache, plus a content-addressed cross-node tier in Atrium CAS keyed by lockfile
  hash — hydrated by a `warmcache-hydrate` init container, captured by the node-sync daemon,
  bounded by TTL/size-cap (Atrium GC) + node LRU. See `docs/archive/notes/warm-lease-build-plan.md`.

## Sandbox warming / cold-start lifecycle

A cold session start decomposes into ~five serial costs. What pre-pays each, and who owns it:

| Cold-start cost | Mechanism | Source |
|---|---|---|
| Pod schedule + container start | warm **pool** of generic pods, keyed `(harness, persona)`, repo-agnostic | **upstream** |
| Image pull | fat pre-baked toolchain image (Rust/Node/Python/uv/Foundry/agent CLIs) | **upstream** |
| Repo clone | per-node repo-cache mirror (DaemonSet) + `git clone --shared` | **upstream** |
| Dependency install (pnpm/cargo/uv) | node depcache + content-keyed Atrium-CAS tier | **Atrium** |
| Build / compile | sccache compiler cache (`RUSTC_WRAPPER`) | **Atrium** |
| Cache growth (both tiers) | TTL + per-workspace size-cap (Atrium GC) · node depcache LRU | **Atrium** |

**The warm pool and the warm-cache compose in two paths.** The warm pool starts
generic pods keyed by harness/persona. Repo-less sessions can claim them directly.
Repo-bearing sessions can also claim a generic warm pod when flat-home
post-claim overlay preparation is supported, the repos are not private, and the
session has default capabilities, no custom env, no persona override, and no
resume thread. After the claim, Centaur rewrites the claimed home for the
session and binds the requested `AGENT_REPOS_JSON` layout. If post-claim prep
fails, the claimed pod is retired and the runtime cold-creates a replacement.

Sessions that need private repo hydration, custom env, non-default capabilities,
persona-specific warm state, resume-thread restore, or a backend without
claimed-home support cold-create a fresh pod. That cold path carries the composed
repo spec and runs the `warmcache-hydrate` init container when the cache inputs
are present. Reflink (FICLONE) makes node-local hydration near-free; a cache-cold
node pulls the store from Atrium CAS over the network.

**Why dependency/build caching isn't upstream:** the warm pool still does not
bake repo dependencies into the generic pod. That would require one pool per
repo×branch×harness×persona. Upstream Centaur's original workload (Slack
tool-calling bots) rarely runs `pnpm install` or `cargo build`, so the cost did
not dominate. Atrium adds dep/build caching as a separate content-addressed layer
for repo software-engineering sessions.

**Future / optional scale work:**
- **Per-repo prebuilt pool** (build-plan §7 "Full") — pools keyed by repo+branch
  with deps+build pre-done; useful only for hot repos because idle cost grows
  quickly.
- **Eager cross-node cache replication** — proactively replicate the hot dep-store
  set to every node, bounded by disk and LRU, so every node is cache-warm.

## Migrations
Use the **`1000+`** range (e.g. `1000_artifact_blobs.sql`). Upstream numbers migrations
sequentially (`0001`, `0002`, …); staying at `1000+` means an upstream migration never
collides with ours when we pull (this bit us three times). `1000+` migrations only depend on
early upstream tables, so applying them last is fine. Renumbering a migration a live DB
already applied means reconciling that DB's `_sqlx_migrations` first.

**Numbers don't collide, but objects can.** Upstream `0033` and fork `1002` both
recreate the `session_warm_sandboxes_status_supported` check constraint with
different status sets, and on an existing DB the newly-pulled upstream migration
runs *after* our already-applied fork one — it re-tightened the constraint under
rows using the fork's `'drained'` status and aborted at deploy (2026-07-11).
Fork `1004` pins the union. When pulling upstream, check new migrations against
constraints/objects the `1000+` range also touches, and remember data-dependent
migrations that pass on fresh DBs can still fail on live ones.

**A new migration file may silently not ship in box-built images.**
`sqlx::migrate!()` embeds the migrations directory at proc-macro expansion, but
cargo does not fingerprint that directory as a crate input — with the api-rs
Docker build's persistent `/build/target` cache mount, adding a migration
without touching any `.rs` file reused the stale rlib and the binary shipped
without the new migration (this dropped `1004` on 2026-07-12; the constraint
had to be applied manually). `centaur-session-sqlx/build.rs` now emits
`cargo:rerun-if-changed=migrations` (sqlx's documented fix) so the crate
re-fingerprints on migration changes. Belt-and-braces: after a deploy that adds
a migration, verify it landed — `select version from _sqlx_migrations order by
version desc limit 3` on `ai_v2`.

## Deploy
From the Atrium repo root:
```
cd centaur
just build-one api-rs
just build-one sandbox
just deploy
```
Required env for Atrium capture: `ATRIUM_CAPTURE_API_KEY` (a dedicated key — do NOT reuse
`CENTAUR_API_KEY`) + `CENTAUR_API_URL`. Deploy-time config (iron-proxy disable, warm-pool
size, …) lives in Atrium's `infra/values.local.yaml`, applied via `CENTAUR_EXTRA_VALUES` at
`just deploy`.
