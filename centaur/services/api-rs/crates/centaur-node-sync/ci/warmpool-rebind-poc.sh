#!/usr/bin/env bash
# SPIKE POC (warm-pool for repo-bearing sessions): find a post-claim "rebind" mechanism that
# makes an ALREADY-RUNNING generic warm pod see a session's repo overlay, mounted AFTER the
# agent container started, via mountPropagation:HostToContainer.
#
# Finding from earlier runs (documented here so we don't relearn it): RE-MOUNTING IN PLACE at the
# pod's exact workspace mountpoint (umount the generic overlay, mount the repo overlay at the same
# path) does NOT propagate into the running container — even with the mount marked `shared`.
# `HostToContainer` (rslave) propagates mounts made UNDER the watched path, not a replacement OF it.
#
# So this POC tests the mechanism that SHOULD work and that the real feature would use:
#   - the warm pod's /workspace is a generic, EMPTY, SHARED mountpoint (the daemon gets "shared"
#     from its DaemonSet volume's mountPropagation: Bidirectional; here we set it directly);
#   - post-claim, the daemon mounts the session's composed overlay at a SUBPATH under it
#     (/workspace/<repo>), which propagates into the running pod;
#   - the first turn then runs in /workspace/<repo>.
#
# Needs a real Linux node (overlay + mountPropagation). Runs on kind (incl. Docker Desktop, since
# we set shared propagation ourselves). Wired as an INFORMATIONAL CI step.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
POD="${POD:-warmpool-rebind-poc}"
SLOT="/run/centaur/merged/${POD}"          # the warm pod's per-pod workspace slot (host), a shared mountpoint
STAGE="/run/centaur/poc-${POD}"            # scratch for the overlay lower/upper/work dirs
REPO_SUBDIR="repo"                         # the session overlay is mounted at <slot>/<REPO_SUBDIR>
NODE="${KIND_CLUSTER}-control-plane"

on_node() { docker exec "${NODE}" sh -ceu "$1"; }
cleanup() {
  kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  on_node "umount '${SLOT}/${REPO_SUBDIR}' 2>/dev/null || true; umount '${SLOT}' 2>/dev/null || true; rm -rf '${STAGE}' '${SLOT}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
# A freshly-created cluster/namespace lags on its default ServiceAccount; pod admission needs it.
for _ in $(seq 1 30); do kubectl -n "${NS}" get serviceaccount default >/dev/null 2>&1 && break; sleep 1; done

echo "==> [1/6] node: make the pod's per-pod slot an EMPTY, SHARED mountpoint (mimics warm-boot generic workspace)"
on_node "
  set -e
  umount '${SLOT}/${REPO_SUBDIR}' 2>/dev/null || true
  umount '${SLOT}' 2>/dev/null || true
  rm -rf '${STAGE}' '${SLOT}'; mkdir -p '${STAGE}/repo-lower/src' '${STAGE}/upper' '${STAGE}/work' '${SLOT}'
  # turn the slot into a SHARED mountpoint (bind-to-self) so submounts under it propagate to the
  # HostToContainer (rslave) pod — this is the property the daemon's Bidirectional volume provides.
  mount --bind '${SLOT}' '${SLOT}'
  mount --make-rshared '${SLOT}'
  echo 'slot is an empty shared mountpoint; propagation:'; findmnt -no TARGET,PROPAGATION '${SLOT}' 2>/dev/null || true
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
      command: ["/bin/sh", "-c", "sleep 3600"]   # harness idle / no turn yet
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

echo "==> [4/6] POST-CLAIM BIND on the node: mount the session overlay at a SUBPATH under the slot"
on_node "
  set -e
  printf 'repo readme bound post-claim\n' > '${STAGE}/repo-lower/README.md'
  printf 'pub fn bound() {}\n' > '${STAGE}/repo-lower/src/lib.rs'
  mkdir -p '${SLOT}/${REPO_SUBDIR}'
  # the agent runs as uid 1001; the daemon chowns the overlay upper to the agent uid
  # (prepare_upper_and_merged) so the first turn can write. Replicate that here.
  chown 1001:1001 '${STAGE}/upper' '${STAGE}/work'
  # mount the composed overlay UNDER the shared slot — propagates into the running rslave pod.
  mount -t overlay overlay -o lowerdir='${STAGE}/repo-lower',upperdir='${STAGE}/upper',workdir='${STAGE}/work',metacopy=off '${SLOT}/${REPO_SUBDIR}'
  echo 'session overlay mounted at slot subpath; propagation:'; findmnt -no TARGET,PROPAGATION '${SLOT}/${REPO_SUBDIR}' 2>/dev/null || true
  ls -la '${SLOT}/${REPO_SUBDIR}'
"

echo "==> [5/6] ASSERT the already-running container now SEES the bound repo under /workspace/${REPO_SUBDIR} (post-start propagation)"
ok=0
for _ in $(seq 1 15); do
  if kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu "
       grep -q 'repo readme bound post-claim' /workspace/${REPO_SUBDIR}/README.md 2>/dev/null &&
       grep -q 'pub fn bound' /workspace/${REPO_SUBDIR}/src/lib.rs 2>/dev/null
     "; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" != "1" ]]; then
  echo "FAIL: running container did NOT see the post-start submount — HostToContainer post-start propagation broke" >&2
  kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu "echo '/workspace:'; ls -la /workspace 2>&1; echo '/workspace/${REPO_SUBDIR}:'; ls -la /workspace/${REPO_SUBDIR} 2>&1 || true" >&2 || true
  on_node "echo 'node /proc/mounts (slot):'; grep '${POD}' /proc/mounts || true" >&2 || true
  exit 1
fi
echo "    OK: running container sees /workspace/${REPO_SUBDIR}/README.md + src/lib.rs bound POST-START (submount propagated)"

echo "==> [6/6] confirm the 'first turn' can work in the bound subdir + writes land in the (capturable) overlay upper"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu "
  echo 'created by first turn' > /workspace/${REPO_SUBDIR}/turn-output.txt
  test -f /workspace/${REPO_SUBDIR}/turn-output.txt
"
on_node "test -f '${STAGE}/upper/turn-output.txt' && echo 'node: first-turn write landed in the overlay upper (capturable by the daemon)'"

echo
echo "OK: a session overlay mounted at a SUBPATH under a generic warm pod's shared workspace slot,"
echo "    AFTER the agent container was running, propagated into the running container. The warm-pool-"
echo "    for-repos post-claim bind primitive is VIABLE via a SUBMOUNT (not an in-place remount).
    Remaining work = warm-spec shared slot + daemon submount in the post-claim window + cd-on-first-turn."
