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

**The warm pool and the warm-cache are orthogonal and compose cleanly.** The pool only
serves *generic* sessions (repo-less, default-persona, no custom env, no resume) — see the
`session_repos_json.is_none()` claim filter in `centaur-session-runtime`. Repo-bearing
sessions *always cold-spawn* a fresh pod whose spec carries `AGENT_REPOS_JSON`, which is
exactly what gates the `warmcache-hydrate` init container. So the two never collide, and the
warm-cache never perturbs the upstream pool (it never touches the warm spec, never forces a
cold start on a claim). Reflink (FICLONE) makes node-local hydration near-free; a cache-cold
node pulls the store from Atrium CAS over the network (bounded, amortized per node).

**Why dependency/build caching isn't upstream:** the warm pool *can't* bake repo/deps in —
that's combinatorial idle cost (one pool per repo×branch×harness×persona) — and upstream
Centaur's original workload (Slack tool-calling bots) rarely runs `pnpm install`/`cargo
build`, so the cost never bit. It bites for Atrium's repo software-engineering sessions, so
this fork adds dep/build caching as a *separate*, content-addressed, post-claim-hydratable
layer rather than baking it into the pool.

**Future (not built; tracked in gbasin/atrium#141):**
- **Warm pool for repo-bearing sessions** — let a repo session claim a generic warm pod and
  bind its repo + cache *post-claim* via the overlay daemon, so it gets warm pod-boot too
  (the build-plan §5 path). Spike: `docs/archive/notes/warm-pool-repo-spike.md`.
- **Per-repo prebuilt pool** (build-plan §7 "Full") — pools keyed by repo+branch with
  deps+build pre-done; combinatorial idle cost, hot repos only.
- **Eager cross-node cache replication** — at large multi-node scale, proactively replicate
  the hot dep-store set to every node (bounded by disk + LRU) so every node is always warm:
  the container-image-p2p pattern (Dragonfly/Kraken). Content-addressed blobs let this drop
  in without touching cache logic.

## Migrations
Use the **`1000+`** range (e.g. `1000_artifact_blobs.sql`). Upstream numbers migrations
sequentially (`0001`, `0002`, …); staying at `1000+` means an upstream migration never
collides with ours when we pull (this bit us three times). `1000+` migrations only depend on
early upstream tables, so applying them last is fine. Renumbering a migration a live DB
already applied means reconciling that DB's `_sqlx_migrations` first.

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
