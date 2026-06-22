#!/usr/bin/env bash
# Live single-pod /atrium read e2e (#72): the full path in one run — the daemon
# materializes the read-only context tree to a node hostPath, then a REAL pod
# (running as the agent uid 1001) mounts it readOnly at /atrium and reads it.
# Asserts: agent reads transcript.md, the mount is read-only, and the full-view
# gate withholds full.md.
# Prereqs: same as atrium-daemon-e2e.sh (Atrium :3001 with ARTIFACT_CAPTURE_API_KEY=node-key,
# kind `centaur`, a current centaur-node-syncd on the node, busybox pullable).
set -euo pipefail
KEY=node-key; NODE_ATRIUM=http://host.docker.internal:3001; NODE=centaur-control-plane
BIN=/usr/local/bin/centaur-node-syncd; HOSTROOT=/var/lib/centaur/atrium; POD=atrium-read-test

echo "[seed] viewer + target with projected records…"
SEED=$(DATABASE_URL="${DATABASE_URL:-postgres://atrium:atrium@localhost:5433/atrium}" pnpm -s tsx scripts/seed-atrium-e2e.mts | tail -1)
V=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['viewer'])")
T=$(echo "$SEED" | python3 -c "import json,sys;print(json.load(sys.stdin)['target'])")
echo "  viewer=$V target=$T"

echo "[materialize] daemon writes the session-scoped /atrium tree to the node hostPath…"
docker exec "$NODE" bash -c "rm -rf $HOSTROOT/$V /tmp/amnt; mkdir -p /tmp/amnt/{upper,merged} $HOSTROOT
  ATRIUM_BASE_URL=$NODE_ATRIUM ATRIUM_CAPTURE_API_KEY=$KEY \
  NODE_SYNC_SESSION=$V NODE_SYNC_UPPER=/tmp/amnt/upper NODE_SYNC_MERGED=/tmp/amnt/merged \
  NODE_SYNC_ATRIUM_ROOT=$HOSTROOT $BIN --once" 2>&1 | grep -vE "status code 403" || true
docker exec "$NODE" test -f "$HOSTROOT/$V/sessions/$T/transcript.md" || { echo "FAIL: not materialized on node"; exit 1; }

echo "[pod] an agent-uid pod mounts the session's /atrium readOnly…"
kubectl delete pod "$POD" --ignore-not-found >/dev/null 2>&1 || true
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: $POD }
spec:
  nodeName: $NODE
  restartPolicy: Never
  securityContext: { runAsUser: 1001, runAsGroup: 1001 }
  containers:
  - name: c
    image: busybox:1.36
    command: ["sh","-c","sleep 300"]
    volumeMounts: [{ name: atrium, mountPath: /atrium, readOnly: true }]
  volumes:
  - name: atrium
    hostPath: { path: $HOSTROOT/$V, type: Directory }
YAML
kubectl wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null

echo "[assert] agent (uid 1001) reads /atrium…"
kubectl exec "$POD" -- cat "/atrium/sessions/$T/transcript.md" | grep -q "snorkelwacker index skip" \
  || { echo "FAIL: agent could not read transcript.md"; exit 1; }
echo "  ✓ read transcript.md"

echo "[assert] mount is read-only (agent write must fail)…"
kubectl exec "$POD" -- sh -c 'echo x > /atrium/hack.txt' 2>/dev/null && { echo "FAIL: write to /atrium succeeded"; exit 1; } || true
kubectl exec "$POD" -- test ! -e /atrium/hack.txt || { echo "FAIL: write leaked"; exit 1; }
echo "  ✓ read-only enforced"

echo "[assert] full-view gate: full.md withheld (ATRIUM_FULL_VIEW off)…"
kubectl exec "$POD" -- test ! -e "/atrium/sessions/$T/full.md" || { echo "FAIL: full.md leaked despite gate off"; exit 1; }
echo "  ✓ full.md withheld"

kubectl delete pod "$POD" --ignore-not-found >/dev/null 2>&1 || true
echo "✅ single-pod /atrium read e2e PASSED (daemon materialize → agent pod readOnly mount → read + gate)"
