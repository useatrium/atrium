# Contributing to Atrium

This guide covers how changes get from a branch to `master`. It applies to both
people and AI agents working in this repo. For how to run the app locally, see the
Quickstart in [README.md](README.md).

## The short version

1. Branch off `master`.
2. Open a pull request into `master`.
3. Give the PR a **Conventional Commit title** (this is enforced by CI).
4. First-time contributors: **sign the CLA** when the bot asks on your PR.
5. Get CI green, then **squash-merge**.

## Licensing and the CLA

Atrium is licensed under **AGPL-3.0-or-later**; the vendored Centaur runtime
under `centaur/` retains its upstream **Apache-2.0 OR MIT** terms (see
[LICENSE](LICENSE), [NOTICE](NOTICE), and [centaur/LICENSE](centaur/LICENSE)).
Changes under `centaur/` stay under the subtree's Apache-2.0 OR MIT terms so
the fork keeps merging cleanly with upstream and fixes can flow back;
everything else is AGPL. Narrow, documented exceptions exist inside the
subtree (currently the Atrium-original `centaur-node-sync` crate, which is
AGPL) — they're recorded in [NOTICE](NOTICE) and in
[centaur/ATRIUM_FORK.md](centaur/ATRIUM_FORK.md).

External contributions require a signed **Contributor License Agreement**:

- **Individuals** — the CLA bot comments on your first pull request; you sign
  by replying with the sentence it asks for. That one signature covers all
  your future contributions. Read the agreement first:
  [.github/cla/individual.md](.github/cla/individual.md).
- **On behalf of an employer** — your employer signs the
  [Corporate CLA](.github/cla/corporate.md) (instructions in the document)
  and lists you as a designated employee; you still sign the individual CLA
  on your PR.

You keep the copyright to your contributions. The CLA grants the project a
broad license to use, sublicense, and relicense them (which is what keeps
commercial licensing and future license changes possible), and in return
commits that every contribution also stays available under the open-source
license it was submitted under. The CLA status (**CLA Assistant**, from
`.github/workflows/cla.yml`) is a required check for merging into `master`.

## Branching

- Always branch off `master`. Name branches by intent, e.g. `feat/…`, `fix/…`,
  `docs/…`, `ci/…`, `chore/…`.
- **Don't commit onto a branch that already has an open PR you don't own**, and
  don't reuse another contributor's branch for unrelated work. Each piece of work
  gets its own branch.

## Working alongside other sessions (important for agents)

This checkout is sometimes shared by more than one agent session at a time, and
extra branches are often checked out in separate Git worktrees (`git worktree
list`). Before you commit:

- Check what branch is actually checked out (`git branch --show-current`). It may
  not be `master`, and it may belong to another session's in-flight work.
- If you need to add unrelated changes (e.g. docs), create your own branch in a
  **separate worktree** so you don't change the branch out from under another
  session:

  ```bash
  git worktree add -b docs/my-change ../atrium-wt-mychange master
  # ...make changes, commit, push from there...
  git worktree remove ../atrium-wt-mychange   # branch + push persist
  ```

- Before merging or relying on a branch, confirm its name in the same command
  that acts on it. Don't assume `master` is the current branch.

## Pull requests

- Open PRs against `master`.
- Make sure CI is green:
  - **Surface** — builds and tests the `surface/` workspace (server + web).
  - **Centaur CI success** — runs the managed Centaur checks when runtime paths change.
  - **Gitleaks** — scans for committed secrets.
  - **Validate PR title** — checks the title is a valid Conventional Commit.
  - **CLA Assistant** — external contributors must have signed the CLA (see
    [Licensing and the CLA](#licensing-and-the-cla)).
- PRs are **squash-merged** through GitHub's merge queue. Once a PR is approved and its
  checks are green, use **Merge when ready**. The queue tests the proposed merge result
  before landing it on `master`.
- The repo is configured so the squash commit's subject is the **PR title**
  (`squash_merge_commit_title=PR_TITLE`). Required workflows run for both pull request
  and merge queue (`merge_group`) events.
- **Centaur upstream-sync exception:** PRs created from `scripts/centaur-sync.sh` must
  preserve the subtree merge commit. After approval and green CI, a maintainer lands
  them outside the queue with `gh pr merge --admin --merge`. Do not use this exception
  for ordinary changes under `centaur/`; those still use the squash queue.

## PR titles (Conventional Commits)

Because the squash commit subject comes from the PR title, the **title** must be a
valid [Conventional Commit](https://www.conventionalcommits.org/). This keeps
`master`'s history consistent and lets changelog/release tooling parse it later.
It's checked by `.github/workflows/pr-title.yml`.

Format:

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`,
`chore`.

Examples:

```
feat(sync): inbound node-daemon hydration
fix(web): stop session pane flicker on reconnect
docs: add top-level README and license
ci: enforce Conventional Commit PR titles for squash merges
```

Your **individual branch commits don't need to follow this format** — they're
squashed away on merge, so there's no need to clean up local history. Only the PR
title is enforced.

## Opening a PR with the CLI

```bash
gh pr create --base master --head <your-branch> \
  --title "docs: short summary" \
  --body "What changed and why."
```
