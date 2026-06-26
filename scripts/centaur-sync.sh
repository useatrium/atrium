#!/usr/bin/env bash
# centaur-sync.sh — pull upstream paradigmxyz/centaur into the vendored centaur/ subtree.
#
# Lands at: atrium repo root as scripts/centaur-sync.sh (referenced from
# centaur/ATRIUM_FORK.md and the root AGENTS.md). Run from anywhere in the atrium repo.
#
# What it does: makes a dated branch, fetches upstream, runs `git subtree pull` with the
# exact flags (so nobody has to remember --prefix / the stat-dirty refresh / "never --squash"),
# then STOPS and prints the next steps. It never opens or merges a PR — upstream pulls are
# reviewed and merged by a human (as a MERGE COMMIT, never squashed).
set -euo pipefail

PREFIX="centaur"
REMOTE="centaur-upstream"
UPSTREAM_URL="https://github.com/paradigmxyz/centaur.git"
REF="${1:-main}"   # optional: sync a different upstream ref

# --- run from the repo root ---
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# --- guards ---
if [[ ! -d "$PREFIX" ]]; then
  echo "✗ no '$PREFIX/' directory here — is this the atrium repo with centaur vendored?" >&2
  exit 1
fi
git update-index -q --refresh || true
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ working tree not clean — commit/stash first (subtree pull needs a clean tree)." >&2
  exit 1
fi

# --- ensure the upstream remote exists ---
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "• adding remote $REMOTE -> $UPSTREAM_URL"
  git remote add "$REMOTE" "$UPSTREAM_URL"
fi

# --- branch + fetch ---
STAMP="$(date +%Y%m%d)"
BRANCH="pull-centaur-${STAMP}"
echo "• branch: $BRANCH"
git switch -c "$BRANCH"
echo "• fetching $REMOTE/$REF ..."
git fetch "$REMOTE" "$REF"

AHEAD="$(git rev-list --count "HEAD..$REMOTE/$REF" 2>/dev/null || echo '?')"
echo "• upstream has $AHEAD commit(s) we don't (touching the subtree's history)"

# --- the actual pull (NON-SQUASH — never pass --squash) ---
echo "• git subtree pull --prefix=$PREFIX $REMOTE $REF"
git update-index -q --refresh || true
if git subtree pull --prefix="$PREFIX" "$REMOTE" "$REF" -m "Pull upstream Centaur ${STAMP}"; then
  cat <<EOF

✓ Clean pull. Next:
    git push -u origin $BRANCH
    gh pr create --base master --head $BRANCH \\
      --title "chore(centaur): sync upstream ${STAMP}" --body "Routine upstream pull."
    # REVIEW, then land as a MERGE COMMIT (never squash):
    gh pr merge $BRANCH --merge
EOF
else
  cat <<EOF

⚠ Conflicts to resolve (expected on files we've diverged on — e.g. crates/harness-server/src/codex.rs).
  Rule: KEEP our fork edits, integrate upstream's intent. centaur/ATRIUM_FORK.md §"What's here"
  is the map of intentional divergence.

  Conflicted files:
$(git diff --name-only --diff-filter=U | sed 's/^/    /')

  Then:
    git add -A && git commit            # completes the subtree merge commit
    cd centaur && just <test target>    # verify the runtime still builds/tests
    git push -u origin $BRANCH
    gh pr create --base master --head $BRANCH --title "chore(centaur): sync upstream ${STAMP}"
    gh pr merge $BRANCH --merge          # MERGE COMMIT, never squash
EOF
  exit 1
fi
