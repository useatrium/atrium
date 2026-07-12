# Atrium — repo guide

This repo holds **two things that ship together**:

- **Atrium** — the collaboration platform (chat, sessions, artifacts, voice). Lives in
  `surface/`. TypeScript, pnpm, Postgres.
- **Centaur** — the agent runtime that actually runs the agents in locked-down sandboxes.
  Lives in `centaur/`. It's **our fork of [`paradigmxyz/centaur`](https://github.com/paradigmxyz/centaur)**,
  vendored into this repo via `git subtree`. Rust + Python + Helm/Kubernetes.

Atrium keeps the data and runs the experience; Centaur runs the agents safely. A change to
the wire protocol between them can now land as **one PR** across both.

## Map

| Path | What's there | Toolchain |
|---|---|---|
| `surface/` | the product: `server/` (Fastify + Postgres), `web/` (Vite + React), `desktop/` (Electron), `mobile/` (Expo), `shared/`, `centaur-client/`, `e2e/`. **This is the pnpm workspace root.** | Node 24+, pnpm 10+ |
| `centaur/` | the agent runtime (our vendored fork — see `centaur/ATRIUM_FORK.md`) | `just`, cargo, Helm/k8s |
| `infra/` | local cluster, stand-in model server, deploy config | — |
| `docs/` | public docs | — |
| `docs/archive/notes/` | archived design scratchpads and build logs | — |

## Where to work / how to build

- **Platform work** → `surface/`. Quickstart:
  ```bash
  cd surface
  docker compose up -d --wait      # Postgres + file storage
  pnpm install && pnpm dev         # server :3001, web :5173
  ```
  Run `pnpm` from `surface/`, not the repo root (the workspace is rooted there).
- **Runtime work** → `centaur/`. It is **self-contained**: its own `Justfile`, cargo
  workspace, and `AGENTS.md`. Start with `cd centaur && just up`. When you work anywhere
  under `centaur/`, that subtree's `AGENTS.md` + `ATRIUM_FORK.md` auto-load — follow them.

## `centaur/` is a vendored upstream fork — treat it as a managed import

- Changes you make in `centaur/` for Atrium features are fine and expected. But:
- **Don't restructure or rename** the `centaur/` tree — it has to keep merging with upstream.
- **Don't edit upstream-owned docs** (`centaur/README.md`, `centaur/AGENTS.md`,
  `centaur/docs/**`) for Atrium-specific reasons — they re-conflict on every upstream pull.
  Put fork-specific guidance in `centaur/ATRIUM_FORK.md` (upstream doesn't have it).
- **DB migrations** under `centaur/` use the **`1000+`** range (never `0001`-style) so an
  upstream migration can't collide with ours. See `centaur/ATRIUM_FORK.md`.
- **Pulling upstream** is a maintainer task: use `scripts/centaur-sync.sh` from the
  repo root. It creates a sibling integration worktree and runs
  `git subtree pull --prefix=centaur centaur-upstream main` there. **Never
  `--squash`** (it silently drops our diverged edits). After review and green CI,
  upstream-sync PRs must bypass the squash queue and land with
  `gh pr merge --admin --merge` so Git retains the upstream parent commit.

## Contributing (people and agents)

- Branch off `master`; open a PR into `master`; **PR title must be a Conventional Commit**
  (CI-enforced). Once approved and green, use **Merge when ready** to enter the squash
  merge queue. The only exception is a `scripts/centaur-sync.sh` upstream-sync PR, which
  must preserve its merge commit as described above. Full flow: `CONTRIBUTING.md`.
- This checkout is often shared by multiple agent sessions with extra branches in `git
  worktree`s. **Before committing, confirm the checked-out branch** (`git branch
  --show-current`) — it may not be `master` and may belong to another session. For
  unrelated edits, make your own branch in a separate worktree.
- Atrium CI (`surface/**`) runs on every PR via `.github/workflows/ci.yml`.
  Centaur CI has also been ported to the root repo in `.github/workflows/centaur-ci.yml`
  because workflows under the vendored `centaur/.github/` tree are inert here (GitHub
  only runs root workflows). The root Centaur success check runs on every PR; its heavy
  jobs are gated on `centaur/**` or workflow changes. Image/chart publishing is
  deliberately excluded. For runtime changes, still validate locally as needed with
  `cd centaur && just …`.
