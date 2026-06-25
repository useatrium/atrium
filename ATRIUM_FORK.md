# Atrium's Centaur — how we work here

This started as a fork of `paradigmxyz/centaur`, but it's now just **our Centaur**.
We don't upstream changes back and we don't track upstream closely. Keep it simple.

> **Claude agents:** the root `CLAUDE.md` imports this file (and `AGENTS.md`), so it
> should already be in your context.

## Remotes & branch
- `fork` → `github.com/gbasin/centaur` — **the repo. Source of truth.**
- `origin` → `github.com/paradigmxyz/centaur` — where it came from. We don't push
  here and rarely pull. Ignore it unless you're deliberately grabbing an upstream fix.
- **One branch: `main`** (on `fork`). All work lives here — commit to it directly,
  or via a short-lived branch merged straight back. The Centaur image deploys from it.

> The branch used to be `atrium/integration`, rebuilt from per-feature topic branches
> by `atrium-integration.{sh,manifest}`. That model is retired — every feature is
> merged onto `main` now, and the tooling is gone. Nothing was lost in the change.

## What's here (the Atrium surface)
The substantive Atrium-only work this fork carries on top of upstream:

- **Artifact capture + workspace sync** — the node-sync capture/hydrate daemon
  ships overlay changes directly to Atrium's CAS ledger. Centaur no longer stages
  artifact bytes or exposes compatibility artifact byte routes.
- **Harness resume** — capture/restore of the rollout transcript so a torn-down
  session resumes the *same* Codex/Claude conversation (ephemeral home + entrypoint
  restore + conditional resume-trigger + a thread-scoped restore proxy).
  See `HARNESS_RESUME_SPEC.md` / `_REPORT.md` / `_E2E.md`.
  **Open:** the watched live-cluster e2e (deferred — it spends real model calls).
- **Claude SDK HITL bridge** — `services/sandbox/claude-sdk-bridge.mjs`: maps the
  Claude Agent SDK `AskUserQuestion` / `canUseTool` path to Atrium/Centaur
  `question_requested` frames and answers back, with defer/resume. Wired via the
  Dockerfile + `entrypoint.sh`; covered by harness-server tests (fake SDK).
  **Open:** the watched live-cluster e2e (real-SDK question round-trip).
- **Subscription auth** — per-execution Codex/Claude OAuth env injection.

## Migrations
Use the **`1000+`** range (e.g. `1000_artifact_blobs.sql`). Upstream numbers
migrations sequentially (`0001`, `0002`, …); staying at `1000+` means an upstream
migration never collides with ours if we ever pull one (this bit us three times).
`1000+` migrations only depend on early upstream tables, so applying them last is
fine. Renumbering a migration a live DB already applied means reconciling that DB's
`_sqlx_migrations` first.

## Deploy
```
just build-one api-rs
just build-one sandbox
just deploy
```
Required env for Atrium capture: `ATRIUM_CAPTURE_API_KEY` (a dedicated key — do
NOT reuse `CENTAUR_API_KEY`) + `CENTAUR_API_URL`. Deploy-time config (iron-proxy
disable, warm-pool size, …) lives in Atrium's `infra/values.local.yaml`, applied via
`CENTAUR_EXTRA_VALUES` at `just deploy`.
