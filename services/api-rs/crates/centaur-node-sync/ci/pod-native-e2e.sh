#!/usr/bin/env bash
# R3 — pod-native distributed e2e: run the node-sync daemon as the ACTUAL privileged
# DaemonSet pod (from the built image) rather than a binary copied onto the node, and
# drive the real capture→adopt round-trip through it. This closes the gap between the
# unit/overlay-syscall proofs and "it runs as the shipped pod".
#
# NOT-VALIDATED-ON-MACOS: the load-bearing mechanic — the privileged init container's
# overlay mount propagating to the node (mountPropagation: Bidirectional) and the
# hardened agent seeing it via HostToContainer — requires a real Linux kernel +
# multi-process node setup. It cannot run on Docker Desktop. Run on a real cluster or
# a GHA ubuntu runner with kind. See notes/sync-hardening-plan.md + agent-sync-design.md.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${SESSION:-c4ovl-pod-e2e}"
AGENT_POD="${AGENT_POD:-c4ovl-agent}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
CAPTURE_SINK="${CAPTURE_SINK:-capture-sink}"

node_sync_pod() {
  kubectl -n "${NS}" get pod -l app.kubernetes.io/component=node-sync \
    -o jsonpath='{.items[0].metadata.name}'
}

wait_for_log() {
  local pattern="$1"
  local description="$2"
  local deadline=$((SECONDS + 120))
  local pod logs

  while (( SECONDS < deadline )); do
    pod="$(node_sync_pod 2>/dev/null || true)"
    if [[ -n "${pod}" ]]; then
      logs="$(kubectl -n "${NS}" logs "${pod}" --tail=200 2>/dev/null || true)"
      if grep -E "${pattern}" <<<"${logs}" >/dev/null; then
        grep -E "${pattern}" <<<"${logs}" | tail -n 1
        return 0
      fi
    fi
    sleep 2
  done

  echo "no ${description} observed from the pod" >&2
  pod="$(node_sync_pod 2>/dev/null || true)"
  if [[ -n "${pod}" ]]; then
    kubectl -n "${NS}" logs "${pod}" --tail=200 >&2 || true
  fi
  return 1
}

echo "==> [1/6] build + load the node-sync image"
if [[ "${NODE_SYNC_SKIP_BUILD_LOAD:-0}" == "1" ]]; then
  echo "    SKIP: NODE_SYNC_SKIP_BUILD_LOAD=1"
else
  IMAGE="${IMAGE}" KIND_CLUSTER="${KIND_CLUSTER}" bash "${HERE}/build-and-load.sh"
fi

echo "==> [2/6] install the capture sink and chart with the node-sync DaemonSet enabled"
kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${NS}" create secret generic centaur-infra-env \
  --from-literal=ARTIFACT_CAPTURE_API_KEY=e2e-capture-key \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "${NS}" apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${CAPTURE_SINK}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${CAPTURE_SINK}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${CAPTURE_SINK}
    spec:
      containers:
        - name: http-echo
          image: hashicorp/http-echo:0.2.3
          imagePullPolicy: IfNotPresent
          args:
            - "-listen=:5678"
            - "-text={\"seq\":1,\"next_cursor\":\"0.0\",\"rows\":[]}"
          ports:
            - name: http
              containerPort: 5678
---
apiVersion: v1
kind: Service
metadata:
  name: ${CAPTURE_SINK}
spec:
  selector:
    app.kubernetes.io/name: ${CAPTURE_SINK}
  ports:
    - name: http
      port: 5678
      targetPort: http
YAML
kubectl -n "${NS}" rollout status "deploy/${CAPTURE_SINK}" --timeout=120s

# The chart declares an external `connect` (1Password) dependency that helm requires
# present in charts/ before install, even though it is condition-gated off here. Fetch
# chart deps first (build respects Chart.lock; update regenerates if the lock drifted).
helm repo add onepassword https://1password.github.io/connect-helm-charts >/dev/null 2>&1 || true
helm dependency build "${HERE}/../../../../../contrib/chart" \
  || helm dependency update "${HERE}/../../../../../contrib/chart"

helm upgrade --install centaur "${HERE}/../../../../../contrib/chart" \
  -n "${NS}" --create-namespace \
  --set nodeSync.enabled=true \
  --set nodeSync.image.repository=centaur-node-sync \
  --set nodeSync.image.tag=e2e \
  --set nodeSync.image.pullPolicy=IfNotPresent \
  --set nodeSync.scanIntervalSeconds=1 \
  --set "nodeSync.atriumBaseUrl=http://${CAPTURE_SINK}.${NS}.svc.cluster.local:5678"

echo "==> [3/6] wait for the node-sync DaemonSet pod to be Ready"
kubectl -n "${NS}" rollout status ds -l app.kubernetes.io/component=node-sync --timeout=180s

echo "==> [4/6] provision a session overlay on the node + seed an agent edit"
kubectl -n "${NS}" delete pod "${AGENT_POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${AGENT_POD}
  annotations:
    centaur.ai/session-id: "${SESSION}"
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: session-upper
      hostPath:
        path: /var/lib/centaur
        type: DirectoryOrCreate
    - name: workspace
      hostPath:
        path: /run/centaur/merged/${SESSION}
        type: DirectoryOrCreate
  initContainers:
    - name: overlay-setup
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/provision-overlay"]
      args: ["--session", "${SESSION}"]
      securityContext:
        privileged: true
      volumeMounts:
        - name: session-upper
          mountPath: /var/lib/centaur
          mountPropagation: Bidirectional
        - name: workspace
          mountPath: /run/centaur/merged/${SESSION}
          mountPropagation: Bidirectional
  containers:
    - name: agent
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "sleep 3600"]
      securityContext:
        runAsUser: 1001
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: workspace
          mountPath: /workspace
          mountPropagation: HostToContainer
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${AGENT_POD}" --timeout=180s

# --- mountPropagation diagnostics (the linchpin: init Bidirectional -> node -> agent
#     HostToContainer). Dump before asserting so a failure shows exactly which hop broke.
echo "--- DIAG: provision-overlay (init) log ---"
kubectl -n "${NS}" logs "${AGENT_POD}" -c overlay-setup 2>&1 || true
echo "--- DIAG: agent view (id, /workspace, mounts) ---"
kubectl -n "${NS}" exec "${AGENT_POD}" -c agent -- /bin/sh -c \
  'id; echo "ls -la /workspace:"; ls -la /workspace 2>&1; echo "overlay mounts:"; grep -E "centaur|overlay" /proc/mounts 2>&1 || true' || true
echo "--- DIAG: node view (mounts + dirs on ${KIND_CLUSTER}-control-plane) ---"
docker exec "${KIND_CLUSTER}-control-plane" sh -c \
  'echo "node overlay/centaur mounts:"; (grep -E "centaur|overlay" /proc/mounts || true); echo "ls /var/lib/centaur/overlays:"; ls -la /var/lib/centaur/overlays 2>&1 || true; echo "ls /run/centaur/merged/'"${SESSION}"':"; ls -la "/run/centaur/merged/'"${SESSION}"'" 2>&1 || true' || true

# Tolerant write: keep going to surface the capture assertion + failure diagnostics even
# if the agent can't write /workspace (e.g. overlay didn't propagate).
if ! kubectl -n "${NS}" exec "${AGENT_POD}" -c agent -- /bin/sh -ceu '
  echo "created from agent" > /workspace/new.txt
  echo "modified from agent" >> /workspace/seed.txt
  rm /workspace/delete-me.txt
  test -f /workspace/new.txt
  test ! -e /workspace/delete-me.txt
'; then
  echo "WARN: agent write exec failed (rc=$?); continuing to capture-assert for diagnostics" >&2
fi

POD="$(node_sync_pod)"
echo "    node-sync pod: ${POD}"

echo "==> [5/6] assert capture round-trip (agent edit -> capture sink) via pod logs"
wait_for_log "capture: [1-9][0-9]* upserts" "capture upsert"
wait_for_log "capture: .* [1-9][0-9]* deletes" "capture delete"

echo "==> [6/6] assert inbound adopt (remote edit -> merged) via pod logs"
if [[ "${NODE_SYNC_E2E_INBOUND:-0}" == "1" ]]; then
  wait_for_log "inbound: [1-9][0-9]* adopted" "inbound adopt"
else
  echo "SKIP: inbound-adopt deferred to the full-Atrium e2e (Phase 3)"
fi

echo "OK: node-sync ran as the DaemonSet pod and captured a pod-native overlay edit"
