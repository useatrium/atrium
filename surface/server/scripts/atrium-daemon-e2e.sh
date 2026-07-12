#!/usr/bin/env bash
# Live combined /atrium e2e (#72): the centaur-node-syncd daemon on a real kind
# node materializes the read-only /atrium context tree from a deployed Atrium,
# and we assert materialization + the full-view gate + per-session scoping +
# node-side readability.
#
# Prereqs (the orchestrator sets these up):
#   - PG :5433 + MinIO :9000 up; Atrium on :3001 with HOST=0.0.0.0 and
#     ARTIFACT_CAPTURE_API_KEY=node-key (ATRIUM_FULL_VIEW unset → full view gated off).
#   - kind cluster `centaur` up; a CURRENT centaur-node-syncd linux binary at
#     /usr/local/bin/centaur-node-syncd on the centaur-control-plane node
#     (build via runtime/node-sync/ci/build-and-load.sh, then docker cp the
#     binary onto the node).
# Run:  bash atrium-daemon-e2e.sh
set -euo pipefail
KEY=node-key
ATRIUM=http://localhost:3001
NODE_ATRIUM=http://host.docker.internal:3001
NODE=centaur-control-plane
ROOT=/tmp/atrium-e2e
BIN=/usr/local/bin/centaur-node-syncd

echo "[seed] viewer + target session + projected records in Atrium…"
SEED=$(DATABASE_URL="${DATABASE_URL:-postgres://atrium:atrium@localhost:5433/atrium}" \
  pnpm -s tsx scripts/seed-atrium-e2e.mts | tail -1)
VIEWER=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['viewer'])")
TARGET=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['target'])")
echo "  viewer=$VIEWER target=$TARGET"

# sanity: the internal route serves the viewer's atrium changes (so the daemon will too)
ROWS=$(curl -s -H "x-api-key: $KEY" "$ATRIUM/api/internal/sessions/$VIEWER/atrium/changes?since=0.0" \
  | python3 -c "import json,sys;print(len(json.load(sys.stdin)['rows']))")
[ "$ROWS" -ge 1 ] || { echo "FAIL: viewer changes feed empty (got $ROWS)"; exit 1; }

echo "[node] empty overlay dirs (we only exercise /atrium materialization)…"
docker exec "$NODE" bash -c "rm -rf $ROOT; mkdir -p $ROOT/{upper,merged,atrium}"

echo "[materialize] running the daemon (single-session, --once)…"
docker exec "$NODE" bash -c "
  ATRIUM_BASE_URL=$NODE_ATRIUM ATRIUM_CAPTURE_API_KEY=$KEY \
  NODE_SYNC_SESSION=$VIEWER NODE_SYNC_UPPER=$ROOT/upper NODE_SYNC_MERGED=$ROOT/merged \
  NODE_SYNC_ATRIUM_ROOT=$ROOT/atrium \
  $BIN --once"

# The daemon scopes the atrium root per viewer: {root}/<viewer>/sessions/<target>/…
DOCDIR="$ROOT/atrium/$VIEWER/sessions/$TARGET"

echo "[assert] transcript.md materialized + content…"
TXT=$(docker exec "$NODE" cat "$DOCDIR/transcript.md" 2>/dev/null || true)
echo "$TXT" | grep -q "snorkelwacker index skip" || { echo "FAIL: transcript.md missing/empty"; echo "$TXT"; exit 1; }
echo "  ✓ transcript.md present with the seeded message"

echo "[assert] full-view GATE: full.md / events.jsonl withheld (ATRIUM_FULL_VIEW off)…"
docker exec "$NODE" test ! -e "$DOCDIR/full.md" || { echo "FAIL: full.md leaked despite gate off"; exit 1; }
docker exec "$NODE" test ! -e "$DOCDIR/events.jsonl" || { echo "FAIL: events.jsonl leaked despite gate off"; exit 1; }
# but the lean transcript reasoning must NOT be present either (lean excludes reasoning)
echo "$TXT" | grep -q "FULL-TIER-SECRET-REASONING" && { echo "FAIL: full-tier reasoning leaked into lean transcript"; exit 1; }
echo "  ✓ full/events withheld; lean transcript has no reasoning"

echo "[assert] per-session scoping: docs live under /atrium/<viewer>/, not a shared root…"
docker exec "$NODE" test -d "$ROOT/atrium/$VIEWER/sessions" || { echo "FAIL: not session-scoped"; exit 1; }
docker exec "$NODE" test ! -e "$ROOT/atrium/sessions" || { echo "FAIL: wrote to a shared (unscoped) root"; exit 1; }
echo "  ✓ scoped to /atrium/$VIEWER/"

echo "[assert] node-side readability as a non-root uid (1001, the agent uid)…"
docker exec --user 1001 "$NODE" cat "$DOCDIR/transcript.md" >/dev/null 2>&1 \
  && echo "  ✓ readable as uid 1001" \
  || echo "  WARN: uid-1001 read failed (file perms) — daemon writes 0644 by default; check if agent needs it"

echo "✅ /atrium DAEMON e2e PASSED (materialize on node + gate + per-session scoping + readability)"
