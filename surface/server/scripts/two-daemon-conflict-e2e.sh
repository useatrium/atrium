#!/usr/bin/env bash
# THE HEADLINE: two daemons (two agents / overlays) concurrently edit the SAME
# shared artifact off the same base → base-aware capture detects a real conflict →
# a human resolves it → both agents CONVERGE. This is the scenario the first build
# never actually proved through the daemon path (it always injected the conflict via
# the host API). It works now because the daemon is STATEFUL (F1): daemon B keeps
# its persisted base_seq=1 even after daemon A advances the ledger to 2.
#
# Prereqs: PG :5433 + MinIO :9000 up; Atrium on :3001 (HOST=0.0.0.0,
# ARTIFACT_CAPTURE_API_KEY=node-key); kind `centaur` up; centaur-node-syncd copied
# into the centaur-control-plane node. Run: bash two-daemon-conflict-e2e.sh
set -euo pipefail
KEY=node-key; ATRIUM=http://localhost:3001; NODE_ATRIUM=http://host.docker.internal:3001; NODE=centaur-control-plane
PSQL=(docker exec atrium-surface-db psql -U atrium -d atrium -tAc)
BASE=$'line1\nline2\nline3\n'

echo "[seed] session…"
SEED=$(DATABASE_URL="${DATABASE_URL:-postgres://atrium:atrium@localhost:5433/atrium}" pnpm -s tsx scripts/seed-session.ts | tail -1)
SID=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionId'])")
echo "  session=$SID"

echo "[v1] host creates proj-x/plan.md v1 + marks it mergeable-doc…"
curl -s -H "x-api-key: $KEY" -H "content-type: text/markdown" --data-binary "$BASE" \
  "$ATRIUM/api/internal/sessions/$SID/artifacts/capture?path=proj-x/plan.md" >/dev/null
"${PSQL[@]}" "UPDATE artifacts SET merge_class='mergeable-doc' WHERE session_id='$SID' AND path='proj-x/plan.md'" >/dev/null

echo "[node] provision two overlays (A,B), both lower=v1…"
docker exec "$NODE" bash -c "
  set -e
  for O in A B; do
    umount /tmp/d2e/\$O/merged 2>/dev/null || true
    rm -rf /tmp/d2e/\$O; mkdir -p /tmp/d2e/\$O/{lower,upper,work,merged}/proj-x 2>/dev/null || mkdir -p /tmp/d2e/\$O/lower/proj-x /tmp/d2e/\$O/upper /tmp/d2e/\$O/work /tmp/d2e/\$O/merged
    printf '$BASE' > /tmp/d2e/\$O/lower/proj-x/plan.md
    mount -t overlay overlay -o lowerdir=/tmp/d2e/\$O/lower,upperdir=/tmp/d2e/\$O/upper,workdir=/tmp/d2e/\$O/work,metacopy=off /tmp/d2e/\$O/merged
  done
  rm -f /tmp/d2e/stateA.json /tmp/d2e/stateB.json
"

run() { # run <A|B>
  local O=$1
  docker exec "$NODE" bash -c "
    ATRIUM_BASE_URL=$NODE_ATRIUM ATRIUM_CAPTURE_API_KEY=$KEY NODE_SYNC_SESSION=$SID \
    NODE_SYNC_UPPER=/tmp/d2e/$O/upper NODE_SYNC_MERGED=/tmp/d2e/$O/merged \
    NODE_SYNC_STATE=/tmp/d2e/state$O.json /usr/local/bin/centaur-node-syncd --once" 2>&1 | sed "s/^/  [$O] /"
}

echo "[hydrate] both daemons hydrate at base=1 (empty uppers)…"
run A; run B

echo "[edit] agents A and B edit the SAME region concurrently…"
docker exec "$NODE" bash -c "printf 'line1\nALICE\nline3\n' > /tmp/d2e/A/merged/proj-x/plan.md"
docker exec "$NODE" bash -c "printf 'line1\nBOB\nline3\n'   > /tmp/d2e/B/merged/proj-x/plan.md"

echo "[capture A] → clean v2…"; run A
echo "[capture B] → base 1 vs latest 2 → CONFLICT…"; run B

CONFLICT_SEQ=$("${PSQL[@]}" "SELECT v.seq FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.session_id='$SID' AND a.path='proj-x/plan.md' AND v.status='conflict' ORDER BY v.seq DESC LIMIT 1")
[ -n "$CONFLICT_SEQ" ] || { echo "FAIL: no conflict version recorded"; exit 1; }
echo "  ✓ conflict recorded at seq $CONFLICT_SEQ"
SIDES=$("${PSQL[@]}" "SELECT v.conflict::text FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.session_id='$SID' AND a.path='proj-x/plan.md' AND v.seq=$CONFLICT_SEQ")
echo "  conflict payload: $SIDES" | head -c 200; echo

echo "[resolve] human writes the merged resolution against the conflict seq…"
curl -s -H "x-api-key: $KEY" -H "content-type: text/markdown" -H "x-artifact-base-seq: $CONFLICT_SEQ" \
  --data-binary $'line1\nMERGED\nline3\n' \
  "$ATRIUM/api/internal/sessions/$SID/artifacts/capture?path=proj-x/plan.md" >/dev/null

echo "[converge] both daemons adopt the resolution…"; run A; run B
A=$(docker exec "$NODE" cat /tmp/d2e/A/merged/proj-x/plan.md)
B=$(docker exec "$NODE" cat /tmp/d2e/B/merged/proj-x/plan.md)
echo "  agent A sees: $(echo "$A" | tr '\n' ' ')"
echo "  agent B sees: $(echo "$B" | tr '\n' ' ')"
# convergence = both agents see the SAME content AND it's the human's resolution
{ [ "$A" = "$B" ] && printf '%s' "$A" | grep -q 'MERGED'; } || { echo "FAIL: agents did not converge (A='$A' B='$B')"; exit 1; }

docker exec "$NODE" bash -c "umount /tmp/d2e/A/merged; umount /tmp/d2e/B/merged" 2>/dev/null || true
echo "✅ TWO-DAEMON conflict→resolve→converge PASSED (base-aware capture via persisted state)"
