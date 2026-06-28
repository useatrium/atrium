# Contributing to Atrium

This guide covers how changes get from a branch to `master`. It applies to both
people and AI agents working in this repo. For how to run the app locally, see the
Quickstart in [README.md](README.md).

## The short version

1. Branch off `master`.
2. Open a pull request into `master`.
3. Give the PR a **Conventional Commit title** (this is enforced by CI).
4. Get CI green, then **squash-merge**.

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
  - **Validate PR title** — checks the title is a valid Conventional Commit.
- PRs are **squash-merged**. The repo is configured so the squash commit's subject
  is the **PR title** (`squash_merge_commit_title=PR_TITLE`).

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
