#!/usr/bin/env bash
# Live DISTRIBUTED e2e: the centaur-node-syncd daemon on a real kind node ↔ a
# deployed Atrium (host) ↔ PG + MinIO. Proves the full Track-C4 loop end-to-end:
#   capture (agent writes on the node → daemon scans overlay upper → POST to Atrium
#            → ledger version → S3)
#   adopt  (a remote actor advances the artifact → daemon polls the feed → fetches
#            → writes through `merged` → the agent sees the remote edit)
#
# Prereqs (the orchestrator sets these up):
#   - PG :5433 + MinIO :9000 up; Atrium server on :3001 with HOST=0.0.0.0 and
#     ARTIFACT_CAPTURE_API_KEY=node-key; kind cluster `centaur` up.
#   - the centaur-node-syncd linux binary at /usr/local/bin/centaur-node-syncd in
#     the `centaur-control-plane` node (docker cp it).
# Run:  bash distributed-daemon-e2e.sh
set -euo pipefail
KEY=node-key
ATRIUM=http://localhost:3001
NODE_ATRIUM=http://host.docker.internal:3001
NODE=centaur-control-plane

echo "[seed] creating a session in Atrium…"
SEED=$(DATABASE_URL="${DATABASE_URL:-postgres://atrium:atrium@localhost:5433/atrium}" pnpm -s tsx scripts/seed-session.ts | tail -1)
SID=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionId'])")
echo "  session=$SID"

echo "[node] provisioning a real overlay + agent write…"
docker exec "$NODE" bash -c "
  set -e
  umount /tmp/de2e/merged 2>/dev/null || true
  rm -rf /tmp/de2e; mkdir -p /tmp/de2e/{lower,upper,work,merged}
  mount -t overlay overlay -o lowerdir=/tmp/de2e/lower,upperdir=/tmp/de2e/upper,workdir=/tmp/de2e/work,metacopy=off /tmp/de2e/merged
  mkdir -p /tmp/de2e/merged/proj-x
  printf 'agent wrote this on the node\n' > /tmp/de2e/merged/proj-x/note.md
"

run_daemon() {
  docker exec "$NODE" bash -c "
    ATRIUM_BASE_URL=$NODE_ATRIUM ATRIUM_CAPTURE_API_KEY=$KEY \
    NODE_SYNC_SESSION=$SID NODE_SYNC_UPPER=/tmp/de2e/upper NODE_SYNC_MERGED=/tmp/de2e/merged \
    /usr/local/bin/centaur-node-syncd --once"
}

echo "[capture] daemon sweep…"; run_daemon
GOT=$(curl -s -H "x-api-key: $KEY" "$ATRIUM/api/internal/sessions/$SID/artifacts/raw?path=proj-x/note.md")
[ "$GOT" = "agent wrote this on the node" ] || { echo "FAIL: capture not in ledger ('$GOT')"; exit 1; }
echo "  ✓ capture landed in Atrium + round-tripped from S3"

echo "[remote] a teammate advances note.md (seq 2)…"
curl -s -H "x-api-key: $KEY" -H "x-artifact-base-seq: 1" -H "content-type: text/markdown" \
  --data-binary 'EDITED REMOTELY by a teammate' \
  "$ATRIUM/api/internal/sessions/$SID/artifacts/capture?path=proj-x/note.md" >/dev/null

echo "[adopt] daemon inbound sweep…"; run_daemon
SEEN=$(docker exec "$NODE" cat /tmp/de2e/merged/proj-x/note.md)
[ "$SEEN" = "EDITED REMOTELY by a teammate" ] || { echo "FAIL: agent didn't see the remote edit ('$SEEN')"; exit 1; }
echo "  ✓ agent sees the remote edit through merged"

docker exec "$NODE" umount /tmp/de2e/merged || true
echo "✅ DISTRIBUTED daemon e2e PASSED (capture out + adopt in, node ↔ Atrium ↔ PG/MinIO)"
