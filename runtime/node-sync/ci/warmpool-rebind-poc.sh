#!/usr/bin/env bash
# SPIKE POC (warm-pool for repo-bearing sessions, FLAT-HOME model): can an already-running generic
# warm pod have its HOME become the session's repo workspace, bound AFTER the agent container
# started, via mountPropagation:HostToContainer?
#
# Flat-home is the default (chart values flatHome: true): the agent's HOME (/home/agent) IS the
# workspace overlay — there is no /workspace. So the rebind has to make HOME itself become the
# session overlay on a running pod.
#
# Finding from earlier runs (kept here so we don't relearn it): mounting/re-mounting AT the exact
# mountpoint a running pod bound does NOT propagate into it — even when the mount is `shared`.
# HostToContainer (rslave) propagates mounts made UNDER the watched path, not a replacement OF it.
# Under flat-home that's fatal for the obvious approach, because HOME *is* the mountpoint.
#
# So this POC tests the mechanism the real feature must use:
#   - the warm pod's HostToContainer volume watches the PARENT of HOME (/home), a shared mountpoint,
#     with HOME (/home/agent) present-but-empty at boot (a ready generic shell);
#   - post-claim, the daemon mounts the session's composed overlay at /home/agent — a SUBMOUNT under
#     the watched /home — which propagates into the running pod, so the agent's HOME flips to the repo;
#   - the first turn then runs in ~ (== /home/agent == the repo, flat — no subdir, no /workspace).
#
# Needs a real Linux node (overlay + mountPropagation). Runs on kind (incl. Docker Desktop, since we
# set shared propagation ourselves). Wired as an INFORMATIONAL CI step.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
POD="${POD:-warmpool-rebind-poc}"
HOME_PATH="/home/agent"                     # the agent's HOME under flat-home (== the workspace)
HOME_PARENT="/home"                         # the warm pod watches the PARENT of HOME (HostToContainer)
SLOT="/run/centaur/merged/${POD}"           # host dir bound into the pod at ${HOME_PARENT} (a shared mountpoint)
HOME_LEAF="agent"                           # the session overlay is mounted at <slot>/<HOME_LEAF> == HOME
STAGE="/run/centaur/poc-${POD}"             # scratch for the overlay lower/upper/work dirs
NODE="${KIND_CLUSTER}-control-plane"

on_node() { docker exec "${NODE}" sh -ceu "$1"; }
cleanup() {
  kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  on_node "umount '${SLOT}/${HOME_LEAF}' 2>/dev/null || true; umount '${SLOT}' 2>/dev/null || true; rm -rf '${STAGE}' '${SLOT}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
# A freshly-created cluster/namespace lags on its default ServiceAccount; pod admission needs it.
for _ in $(seq 1 30); do kubectl -n "${NS}" get serviceaccount default >/dev/null 2>&1 && break; sleep 1; done

echo "==> [1/6] node: make the HOME PARENT (${HOME_PARENT}) an empty SHARED mountpoint; HOME present-but-empty"
on_node "
  set -e
  umount '${SLOT}/${HOME_LEAF}' 2>/dev/null || true
  umount '${SLOT}' 2>/dev/null || true
  rm -rf '${STAGE}' '${SLOT}'
  mkdir -p '${STAGE}/repo-lower/src' '${STAGE}/upper' '${STAGE}/work' '${SLOT}/${HOME_LEAF}'
  # share the slot (bound to itself) so submounts under it propagate to the HostToContainer pod —
  # the property the daemon's Bidirectional DaemonSet volume provides; a raw mount is private.
  mount --bind '${SLOT}' '${SLOT}'
  mount --make-rshared '${SLOT}'
  echo 'home-parent shared mountpoint; propagation:'; findmnt -no TARGET,PROPAGATION '${SLOT}' 2>/dev/null || true
"

echo "==> [2/6] start a generic warm pod: HOME=${HOME_PATH} (empty), parent ${HOME_PARENT} bound HostToContainer, idle agent"
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
    - name: home
      hostPath:
        path: ${SLOT}
        type: DirectoryOrCreate
  containers:
    - name: agent
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "sleep 3600"]   # harness idle / no turn yet
      env:
        - { name: HOME, value: "${HOME_PATH}" }
      securityContext:
        runAsUser: 1001
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
        seccompProfile: { type: RuntimeDefault }
      volumeMounts:
        - name: home
          mountPath: ${HOME_PARENT}
          mountPropagation: HostToContainer
      workingDir: ${HOME_PATH}
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${POD}" --timeout=120s

echo "==> [3/6] confirm container RUNNING + \$HOME empty (generic flat-home shell, no session bound yet)"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
  echo "agent up as $(id -u); HOME=$HOME; ls -la $HOME:"; ls -la "$HOME"
  test -z "$(ls -A "$HOME" 2>/dev/null)"
'
echo "    OK: generic warm pod ready, \$HOME (${HOME_PATH}) empty, container already running"

echo "==> [4/6] POST-CLAIM BIND on the node: mount the session overlay AT HOME (submount under the watched parent)"
on_node "
  set -e
  printf 'repo readme bound post-claim\n' > '${STAGE}/repo-lower/README.md'
  printf 'pub fn bound() {}\n' > '${STAGE}/repo-lower/src/lib.rs'
  # the agent runs as uid 1001; the daemon chowns the overlay upper to the agent uid so HOME is writable.
  chown 1001:1001 '${STAGE}/upper' '${STAGE}/work'
  # mount the composed overlay at <slot>/${HOME_LEAF} (== /home/agent == HOME) — a submount under the
  # shared ${HOME_PARENT}, so it propagates into the running rslave pod and HOME flips to the repo.
  mount -t overlay overlay -o lowerdir='${STAGE}/repo-lower',upperdir='${STAGE}/upper',workdir='${STAGE}/work',metacopy=off '${SLOT}/${HOME_LEAF}'
  echo 'session overlay mounted at HOME; propagation:'; findmnt -no TARGET,PROPAGATION '${SLOT}/${HOME_LEAF}' 2>/dev/null || true
"

echo "==> [5/6] ASSERT the already-running container's \$HOME now IS the repo (flat — no subdir), post-start"
ok=0
for _ in $(seq 1 15); do
  if kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
       grep -q "repo readme bound post-claim" "$HOME/README.md" 2>/dev/null &&
       grep -q "pub fn bound" "$HOME/src/lib.rs" 2>/dev/null &&
       cd "$HOME" && test -f ./README.md
     '; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" != "1" ]]; then
  echo "FAIL: running container's \$HOME did NOT become the repo — submount-at-HOME post-start propagation broke" >&2
  kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu 'echo "HOME=$HOME:"; ls -la "$HOME" 2>&1 || true' >&2 || true
  on_node "echo 'node /proc/mounts (slot):'; grep '${POD}' /proc/mounts || true" >&2 || true
  exit 1
fi
echo "    OK: running container's \$HOME (${HOME_PATH}) IS the repo, flat — README.md + src/lib.rs bound POST-START"

echo "==> [6/6] confirm the 'first turn' works in ~ + writes land in the (capturable) overlay upper"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
  cd "$HOME"
  echo "created by first turn" > ./turn-output.txt
  test -f "$HOME/turn-output.txt"
'
on_node "test -f '${STAGE}/upper/turn-output.txt' && echo 'node: first-turn write landed in the overlay upper (capturable by the daemon)'"

echo
echo "OK (flat-home): a session overlay mounted AT HOME (/home/agent) — a submount under the warm pod's"
echo "    shared /home — AFTER the agent container was running flipped the running container's \$HOME to"
echo "    the repo workspace, flat (no /workspace, no subdir). The warm-pool-for-repos post-claim bind is"
echo "    VIABLE under flat-home via a SUBMOUNT-AT-HOME. Build: warm-spec shared /home + daemon submount at"
echo "    HOME in the post-claim window + reconcile boot-time HOME setup (shims/dotfiles) with the overlay."
