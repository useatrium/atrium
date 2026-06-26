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
  git remote add centaur-upstream https://github.com/paradigmxyz/centaur.git   # one-time
  git fetch centaur-upstream main
  git update-index -q --refresh
  git subtree pull --prefix=centaur centaur-upstream main -m "Pull upstream Centaur $(date +%F)"
  ```
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
