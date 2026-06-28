#!/usr/bin/env bash
# SPIKE POC (warm-pool for repo-bearing sessions): prove the ONE unproven primitive of the
# "post-claim rebind" design — can the overlay at a RUNNING generic warm pod's workspace slot
# be RE-MOUNTED IN PLACE (swap the empty/generic lower for the claimed session's repo lower)
# and have the already-running agent container SEE the swap, via mountPropagation:HostToContainer?
#
# Why this is the real test (from the spike recon):
#   - A warm pod already runs the overlay init containers at boot with EMPTY repos, so it has a
#     generic overlay mounted at a PER-POD slot (`/run/centaur/merged/<warm-sandbox-id>`, keyed
#     by the pod's own id, NOT the thread/session). It is Ready with an empty /workspace.
#   - On claim there is a window (after claim(), before the first `turn.start`) where the harness
#     is attached but idle. The rebind = re-mount the overlay at that SAME per-pod slot with the
#     claimed repos as the lower, then let the first turn run in it.
#   - The existing pod-native-e2e only proves the daemon's mount is seen when it lands BEFORE the
#     agent container starts. This isolates the post-start, remount-in-place case.
#
# Needs a real Linux node (overlay + mountPropagation) — run on kind, NOT Docker Desktop.
# Wired as an INFORMATIONAL CI step.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
POD="${POD:-warmpool-rebind-poc}"
SLOT="/run/centaur/merged/${POD}"          # the warm pod's per-pod workspace slot (host)
STAGE="/run/centaur/poc-${POD}"            # scratch for the overlay lower/upper/work dirs
NODE="${KIND_CLUSTER}-control-plane"

on_node() { docker exec "${NODE}" sh -ceu "$1"; }
cleanup() {
  kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  on_node "umount '${SLOT}' 2>/dev/null || true; rm -rf '${STAGE}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -

echo "==> [1/6] node: stage a GENERIC (empty) overlay and mount it at the pod's per-pod slot (mimics warm-boot)"
on_node "
  set -e
  umount '${SLOT}' 2>/dev/null || true
  rm -rf '${STAGE}'; mkdir -p '${STAGE}/generic-lower' '${STAGE}/upper' '${STAGE}/work' '${SLOT}'
  mount -t overlay overlay -o lowerdir='${STAGE}/generic-lower',upperdir='${STAGE}/upper',workdir='${STAGE}/work',metacopy=off '${SLOT}'
  echo 'slot mounted (generic/empty):'; ls -la '${SLOT}'
"

echo "==> [2/6] start a generic warm pod bound to that slot (HostToContainer), idle agent, no session"
kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: workspace
      hostPath:
        path: ${SLOT}
        type: DirectoryOrCreate
  containers:
    - name: agent
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "sleep 3600"]   # harness idle / no turn yet (mimics attached-but-pre-first-turn)
      securityContext:
        runAsUser: 1001
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
        seccompProfile: { type: RuntimeDefault }
      volumeMounts:
        - name: workspace
          mountPath: /workspace
          mountPropagation: HostToContainer
      workingDir: /workspace
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${POD}" --timeout=120s

echo "==> [3/6] confirm container RUNNING + /workspace empty (generic, no session bound yet)"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
  echo "agent up as $(id -u); /workspace:"; ls -la /workspace
  test -z "$(ls -A /workspace 2>/dev/null)"
'
echo "    OK: generic warm pod ready, /workspace empty, container already running"

echo "==> [4/6] POST-CLAIM REBIND on the node: remount the slot in place with the claimed repo lower"
on_node "
  set -e
  mkdir -p '${STAGE}/repo-lower/src'
  printf 'repo readme bound post-claim\n' > '${STAGE}/repo-lower/README.md'
  printf 'pub fn bound() {}\n' > '${STAGE}/repo-lower/src/lib.rs'
  # swap in place: unmount the generic overlay, mount the session overlay at the SAME slot
  umount '${SLOT}'
  mount -t overlay overlay -o lowerdir='${STAGE}/repo-lower',upperdir='${STAGE}/upper',workdir='${STAGE}/work',metacopy=off '${SLOT}'
  echo 'slot remounted (repo lower):'; ls -la '${SLOT}'
"

echo "==> [5/6] ASSERT the already-running container now SEES the rebound repo (post-start remount propagation)"
ok=0
for _ in $(seq 1 15); do
  if kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
       grep -q "repo readme bound post-claim" /workspace/README.md 2>/dev/null &&
       grep -q "pub fn bound" /workspace/src/lib.rs 2>/dev/null
     '; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" != "1" ]]; then
  echo "FAIL: running container did NOT see the post-start remount — HostToContainer post-start propagation broke" >&2
  kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu 'echo "/workspace:"; ls -la /workspace 2>&1 || true' >&2 || true
  on_node "echo 'node /proc/mounts (slot):'; grep '${POD}' /proc/mounts || true" >&2 || true
  exit 1
fi
echo "    OK: running container sees /workspace/README.md + src/lib.rs bound POST-CLAIM (in-place remount propagated)"

echo "==> [6/6] confirm the 'first turn' can work + writes land in the (capturable) overlay upper"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
  echo "created by first turn" > /workspace/turn-output.txt
  test -f /workspace/turn-output.txt
'
on_node "test -f '${STAGE}/upper/turn-output.txt' && echo 'node: first-turn write landed in the overlay upper (capturable by the daemon)'"

echo
echo "OK: a generic warm pod's workspace was rebound to a session's repo overlay by an in-place"
echo "    remount AFTER the agent container was running, and the running container saw it. The"
echo "    warm-pool-for-repos post-claim rebind primitive is VIABLE. Remaining work = wire the"
echo "    daemon to do this remount in the post-claim window + a readiness handshake before turn 1."
