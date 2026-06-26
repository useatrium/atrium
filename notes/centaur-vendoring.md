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
- **Pull upstream:** `scripts/centaur-sync.sh` (wraps `git subtree pull` with the right
  flags/guards). Details + conflict guidance in [`centaur/ATRIUM_FORK.md`](../centaur/ATRIUM_FORK.md).
- **Merge method — load-bearing:** the nest and every upstream-pull PR **must land as a
  MERGE COMMIT, never squash.** Squashing flattens the centaur ancestry → the next
  `subtree pull` fails with "refusing to merge unrelated histories." This is why
  `master` allows merge commits and no longer requires linear history. Normal atrium PRs
  still squash by convention.
- **Migrations:** keep centaur DB migrations in the `1000+` range (collision-free vs upstream).

## Deploy
Unchanged, just from the subtree now: `cd centaur && just build-one api-rs && just build-one sandbox && just deploy`.

## Deferred fast-follow: port Centaur CI
Centaur's own workflows live at `centaur/.github/workflows/` and are **inert** here (GitHub
only runs root `.github/workflows/`). Porting the *check* workflows (cargo build/test,
`check-migration-order.sh` — the 1000+ guard, console-ci) to root with `paths: ['centaur/**']`
is a tracked fast-follow. **Do NOT port the publishing workflows** (`publish-images.yml`,
`node-sync-image.yml`, `release-chart.yml`, `docs.yml`) blindly — firing those from atrium
would push images/charts to Centaur's registries from the wrong repo; they need deliberate
re-targeting or omission. Until ported, validate centaur changes locally (`cd centaur && just …`).
