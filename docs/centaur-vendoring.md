# Centaur vendored into `centaur/` (git subtree)

Centaur — the agent runtime, our fork of [`paradigmxyz/centaur`](https://github.com/paradigmxyz/centaur) —
now lives in this repo at `centaur/`, vendored via `git subtree` (non-squash). It used to be
a separate repo (`gbasin/centaur`). Atrium is now the single source of truth; the fork repo
is archived; there is no outbound sync.

## Why nested
One clone, and **atomic cross-stack PRs** — a wire-protocol change to the Centaur producer
(`centaur/packages/harness-events`) and its consumer (`surface/centaur-client`) can land in
one PR/CI run instead of two coordinated PRs across two repos.

## How sync works (important)
- **Direction:** only inbound (upstream → `centaur/`). We never push upstream.
- **Pull upstream:** `scripts/centaur-sync.sh` (creates a sibling integration worktree,
  then wraps `git subtree pull` with the right flags/guards). Details + conflict guidance
  in [`centaur/ATRIUM_FORK.md`](../centaur/ATRIUM_FORK.md).
- **Merge method — load-bearing:** the nest and every upstream-pull PR **must land as a
  MERGE COMMIT, never squash.** Squashing flattens the centaur ancestry → the next
  `subtree pull` fails with "refusing to merge unrelated histories." This is why
  `master` allows merge commits and no longer requires linear history. After approval
  and green CI, land the sync PR with `gh pr merge --admin --merge`; `--admin` bypasses
  the squash-only merge queue. Normal Atrium and Centaur feature PRs still use the queue.
- **Migrations:** keep centaur DB migrations in the `1000+` range (collision-free vs upstream).

## Deploy
Unchanged, just from the subtree now: `cd centaur && just build-one api-rs && just build-one sandbox && just deploy`.

## Centaur CI
Centaur's own workflows live at `centaur/.github/workflows/` and are **inert** here (GitHub
only runs root `.github/workflows/`).

**Ported → `.github/workflows/centaur-ci.yml`**: the runtime checks `migration-order` (the
1000+ guard), `rust-api` (fmt/clippy/test + postgres integration), `node-sync-overlay`, and the
heavy `node-sync-pod-e2e` (kind cluster). The `depot-*` runners upstream fall back to
`ubuntu-latest` off `paradigmxyz`, and no secrets are needed.

The workflow **always runs** (no top-level path filter) on PRs and merge groups, but the
heavy jobs gate on a `ci_changes` detector — so a non-centaur change just runs the detector
and aggregator (heavy jobs skip, ~15s) and reports green. This makes **`Centaur CI success`
a safe required check** (it reports on every PR and merge group). **`node-sync-pod-e2e`
(kind) runs whenever node-sync paths change — PRs and merge groups included — and is part
of the required aggregator** (allowed-skips covers the
non-node-sync case). It was once excluded as "flaky", but its only real failures were real
bugs, and the exclusion let a hydration regression (#220) merge and sit silently red on
master for two days. A node-sync PR takes ~6–7 min (the kind e2e is the long pole).

**Not ported (intentional):**
- *Bot test jobs* (`slackbot/linearbot/discord/teams`) — deferred; peripheral to atrium. Add
  to `centaur-ci.yml` if their tests start mattering here.
- *Publishing workflows* (`publish-images.yml`, `node-sync-image.yml`, `release-chart.yml`,
  `docs.yml`) — **must not** run from atrium (they'd push images/charts to Centaur's
  registries from the wrong repo). Deploys still happen via `cd centaur && just deploy`.
