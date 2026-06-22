#!/usr/bin/env bash
# Live /atrium ACL-isolation e2e (#72): proves the per-session-scoped materializer
# does NOT leak one viewer's private context to another agent on the same node.
# A private target session is visible to viewer A (channel member) but not to
# viewer B (non-member); B's daemon run must NOT materialize it.
# Prereqs: same as atrium-daemon-e2e.sh (Atrium :3001 with ARTIFACT_CAPTURE_API_KEY=node-key,
# kind `centaur`, a current centaur-node-syncd on the node).
set -euo pipefail
KEY=node-key; ATRIUM=http://localhost:3001; NODE_ATRIUM=http://host.docker.internal:3001
NODE=centaur-control-plane; ROOT=/tmp/atrium-iso; BIN=/usr/local/bin/centaur-node-syncd

echo "[seed] private target + viewer A (member) + viewer B (non-member)…"
SEED=$(DATABASE_URL="${DATABASE_URL:-postgres://atrium:atrium@localhost:5433/atrium}" pnpm -s tsx scripts/seed-atrium-isolation.mts | tail -1)
A=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['viewerA'])")
B=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['viewerB'])")
T=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['target'])")
echo "  viewerA=$A viewerB=$B target(private)=$T"

# sanity via the internal feed: A sees T, B does not
AROWS=$(curl -s -H "x-api-key: $KEY" "$ATRIUM/api/internal/sessions/$A/atrium/changes?since=0.0" | python3 -c "import json,sys;print(sum(1 for r in json.load(sys.stdin)['rows'] if r['sessionId']=='$T'))")
BROWS=$(curl -s -H "x-api-key: $KEY" "$ATRIUM/api/internal/sessions/$B/atrium/changes?since=0.0" | python3 -c "import json,sys;print(sum(1 for r in json.load(sys.stdin)['rows'] if r['sessionId']=='$T'))")
[ "$AROWS" = "1" ] || { echo "FAIL: member A's feed should include the private target (got $AROWS)"; exit 1; }
[ "$BROWS" = "0" ] || { echo "FAIL: non-member B's feed leaked the private target (got $BROWS)"; exit 1; }
echo "  ✓ feed ACL: A sees the private target, B does not"

run() { # $1=viewer
  docker exec "$NODE" bash -c "rm -rf $ROOT/$1; mkdir -p $ROOT/$1/{upper,merged,atrium}"
  docker exec "$NODE" bash -c "
    ATRIUM_BASE_URL=$NODE_ATRIUM ATRIUM_CAPTURE_API_KEY=$KEY \
    NODE_SYNC_SESSION=$1 NODE_SYNC_UPPER=$ROOT/$1/upper NODE_SYNC_MERGED=$ROOT/$1/merged \
    NODE_SYNC_ATRIUM_ROOT=$ROOT/$1/atrium $BIN --once" 2>&1 | grep -vE "status code 403" || true
}

echo "[A] daemon run (member) → must materialize the private target…"
run "$A"
docker exec "$NODE" test -f "$ROOT/$A/atrium/$A/sessions/$T/transcript.md" \
  || { echo "FAIL: member A did not materialize the private target"; exit 1; }
docker exec "$NODE" cat "$ROOT/$A/atrium/$A/sessions/$T/transcript.md" | grep -q "classified zibblefarb" \
  || { echo "FAIL: A's materialized transcript missing content"; exit 1; }
echo "  ✓ A materialized the private target"

echo "[B] daemon run (non-member) → must NOT materialize the private target…"
run "$B"
docker exec "$NODE" test ! -e "$ROOT/$B/atrium/$B/sessions/$T" \
  || { echo "FAIL: non-member B LEAKED the private target into /atrium"; exit 1; }
echo "  ✓ B did not materialize the private target (ACL isolation holds)"

echo "✅ /atrium ACL-isolation e2e PASSED (private target visible to the member viewer, withheld from the non-member viewer)"
