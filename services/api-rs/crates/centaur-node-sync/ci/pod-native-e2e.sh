#!/usr/bin/env bash
# R3 — pod-native distributed e2e: run the node-sync daemon as the ACTUAL privileged
# DaemonSet pod (from the built image) rather than a binary copied onto the node, and
# drive the real capture→adopt round-trip through it. This closes the gap between the
# unit/overlay-syscall proofs and "it runs as the shipped pod".
#
# NOT-VALIDATED-ON-MACOS: the load-bearing mechanic — the privileged node-sync
# DaemonSet mounts the overlay on the node and the hardened agent sees it via
# HostToContainer — requires a real Linux kernel + multi-process node setup. It
# cannot run on Docker Desktop. Run on a real cluster or a GHA ubuntu runner with
# kind. See notes/sync-hardening-plan.md + agent-sync-design.md.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${SESSION:-c4ovl-pod-e2e}"
AGENT_POD="${AGENT_POD:-c4ovl-agent}"
REPO_SESSION="${REPO_SESSION:-${SESSION}-repo}"
REPO_AGENT_POD="${REPO_AGENT_POD:-${AGENT_POD}-repo}"
MULTI_REPO_SESSION="${MULTI_REPO_SESSION:-${SESSION}-multi-repo}"
MULTI_REPO_AGENT_POD="${MULTI_REPO_AGENT_POD:-${AGENT_POD}-multi-repo}"
HYDRATE_SESSION="${HYDRATE_SESSION:-${SESSION}-hydrate}"
HYDRATE_POD="${HYDRATE_POD:-${AGENT_POD}-hydrate}"
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

echo "==> [1/9] build + load the node-sync image"
if [[ "${NODE_SYNC_SKIP_BUILD_LOAD:-0}" == "1" ]]; then
  echo "    SKIP: NODE_SYNC_SKIP_BUILD_LOAD=1"
else
  IMAGE="${IMAGE}" KIND_CLUSTER="${KIND_CLUSTER}" bash "${HERE}/build-and-load.sh"
fi

echo "==> [2/9] install the capture sink and chart with the node-sync DaemonSet enabled"
kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${NS}" create secret generic centaur-infra-env \
  --from-literal=ATRIUM_CAPTURE_API_KEY=e2e-capture-key \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CAPTURE_SINK}-mock
data:
  mock_atrium.py: |
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse

    SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("%s - %s" % (self.address_string(), fmt % args), flush=True)

        def send_body(self, status, body, content_type="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def session_id(self, path):
            parts = [part for part in path.split("/") if part]
            for idx, part in enumerate(parts):
                if part == "sessions" and idx + 1 < len(parts):
                    return parts[idx + 1]
            return "unknown"

        def do_GET(self):
            path = urlparse(self.path).path
            if path.endswith("/hydration-scope"):
                session = self.session_id(path)
                self.send_body(200, {
                    "sessionId": session,
                    "scope": "session",
                    "paths": [{
                        "path": "shared/hydrated.md",
                        "latestSeq": 1,
                        "kind": "created",
                        "sha": SHA,
                    }],
                })
                return
            if "artifacts/raw" in path:
                self.send_body(200, "hydrated by atrium\n", "text/markdown")
                return
            self.send_body(200, {"seq": 1, "next_cursor": "0.0", "rows": []})

        def do_POST(self):
            length = int(self.headers.get("content-length", "0") or "0")
            if length:
                self.rfile.read(length)
            path = urlparse(self.path).path
            if "artifacts/commit-group" in path:
                self.send_body(200, {"results": []})
                return
            if "artifacts/capture" in path:
                self.send_body(200, {"seq": 1, "status": "normal"})
                return
            self.send_body(200, {"ok": True})

    ThreadingHTTPServer(("0.0.0.0", 5678), Handler).serve_forever()
---
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
        - name: mock-atrium
          image: python:3.12-slim
          imagePullPolicy: IfNotPresent
          command: ["python", "/mock/mock_atrium.py"]
          ports:
            - name: http
              containerPort: 5678
          readinessProbe:
            httpGet:
              path: /healthz
              port: 5678
            initialDelaySeconds: 1
            periodSeconds: 1
          volumeMounts:
            - name: mock
              mountPath: /mock
              readOnly: true
      volumes:
        - name: mock
          configMap:
            name: ${CAPTURE_SINK}-mock
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
	  --set nodeSync.hydrateArtifacts=true \
	  --set "nodeSync.atriumBaseUrl=http://${CAPTURE_SINK}.${NS}.svc.cluster.local:5678"

echo "==> [3/9] wait for the node-sync DaemonSet pod to be Ready"
kubectl -n "${NS}" rollout status ds -l app.kubernetes.io/component=node-sync --timeout=180s

echo "==> [4/9] write a fixture-lower session manifest and wait for daemon-owned overlay"
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
    - name: overlays-root
      hostPath:
        path: /var/lib/centaur/overlays
        type: DirectoryOrCreate
    - name: workspace
      hostPath:
        path: /run/centaur/merged/${SESSION}
        type: DirectoryOrCreate
  initContainers:
    - name: overlay-manifest-writer
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/provision-overlay"]
      args: ["--manifest-only", "--session", "${SESSION}", "--agent-uid", "1001"]
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: overlays-root
          mountPath: /var/lib/centaur/overlays
    - name: overlay-readiness-wait
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          marker="/run/centaur/merged/${SESSION}/.centaur-workspace-ready"
          deadline=\$(( \$(date +%s) + 120 ))
          while [ ! -f "\${marker}" ]; do
            if [ "\$(date +%s)" -ge "\${deadline}" ]; then
              echo "timed out waiting for \${marker}" >&2
              exit 1
            fi
            sleep 1
          done
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: workspace
          mountPath: /run/centaur/merged/${SESSION}
          mountPropagation: HostToContainer
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
      workingDir: /workspace
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${AGENT_POD}" --timeout=180s

# --- mountPropagation diagnostics (the linchpin: daemon Bidirectional -> node -> agent
#     HostToContainer). Dump before asserting so a failure shows exactly which hop broke.
echo "--- DIAG: provision-overlay manifest-writer log ---"
kubectl -n "${NS}" logs "${AGENT_POD}" -c overlay-manifest-writer 2>&1 || true
echo "--- DIAG: readiness wait log ---"
kubectl -n "${NS}" logs "${AGENT_POD}" -c overlay-readiness-wait 2>&1 || true
echo "--- DIAG: agent view (id, /workspace, mounts) ---"
kubectl -n "${NS}" exec "${AGENT_POD}" -c agent -- /bin/sh -c \
  'id; echo "ls -la /workspace:"; ls -la /workspace 2>&1; echo "overlay mounts:"; grep -E "centaur|overlay" /proc/mounts 2>&1 || true' || true
echo "--- DIAG: node view (mounts + dirs on ${KIND_CLUSTER}-control-plane) ---"
docker exec "${KIND_CLUSTER}-control-plane" sh -c \
  'echo "node overlay/centaur mounts:"; (grep -E "centaur|overlay" /proc/mounts || true); echo "ls /var/lib/centaur/overlays:"; ls -la /var/lib/centaur/overlays 2>&1 || true; echo "manifest:"; cat "/var/lib/centaur/overlays/.sessions/'"${SESSION}"'.json" 2>&1 || true; echo "ls /run/centaur/merged/'"${SESSION}"':"; ls -la "/run/centaur/merged/'"${SESSION}"'" 2>&1 || true' || true

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

echo "==> [5/9] assert fixture-lower capture round-trip (agent edit -> capture sink) via pod logs"
wait_for_log "capture: [1-9][0-9]* upserts" "capture upsert"
wait_for_log "capture: .* [1-9][0-9]* deletes" "capture delete"

echo "==> [6/9] provision a repo-lower session and assert only new files hit upper/capture"
kubectl -n "${NS}" delete pod "${REPO_AGENT_POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${REPO_AGENT_POD}
  annotations:
    centaur.ai/session-id: "${REPO_SESSION}"
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: overlays-root
      hostPath:
        path: /var/lib/centaur/overlays
        type: DirectoryOrCreate
    - name: repos-root
      hostPath:
        path: /var/lib/centaur/repos
        type: DirectoryOrCreate
    - name: workspace
      hostPath:
        path: /run/centaur/merged/${REPO_SESSION}
        type: DirectoryOrCreate
  initContainers:
    - name: repo-seed
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          repo="/var/lib/centaur/repos/${REPO_SESSION}"
          rm -rf "\${repo}"
          mkdir -p "\${repo}/src"
          printf 'repo lower readme\n' > "\${repo}/README.md"
          printf 'pub fn lower() {}\n' > "\${repo}/src/lib.rs"
          chmod 0755 "\${repo}" "\${repo}/src"
          chmod 0644 "\${repo}/README.md" "\${repo}/src/lib.rs"
          ls -la "\${repo}" "\${repo}/src"
      volumeMounts:
        - name: repos-root
          mountPath: /var/lib/centaur/repos
    - name: overlay-manifest-writer
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/provision-overlay"]
      args: ["--manifest-only", "--session", "${REPO_SESSION}", "--repo", "/var/lib/centaur/repos/${REPO_SESSION}", "--agent-uid", "1001"]
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: overlays-root
          mountPath: /var/lib/centaur/overlays
    - name: overlay-readiness-wait
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          marker="/run/centaur/merged/${REPO_SESSION}/.centaur-workspace-ready"
          deadline=\$(( \$(date +%s) + 120 ))
          while [ ! -f "\${marker}" ]; do
            if [ "\$(date +%s)" -ge "\${deadline}" ]; then
              echo "timed out waiting for \${marker}" >&2
              exit 1
            fi
            sleep 1
          done
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: workspace
          mountPath: /run/centaur/merged/${REPO_SESSION}
          mountPropagation: HostToContainer
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
      workingDir: /workspace
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${REPO_AGENT_POD}" --timeout=180s

echo "--- DIAG: repo seed log ---"
kubectl -n "${NS}" logs "${REPO_AGENT_POD}" -c repo-seed 2>&1 || true
echo "--- DIAG: repo provision-overlay manifest-writer log ---"
kubectl -n "${NS}" logs "${REPO_AGENT_POD}" -c overlay-manifest-writer 2>&1 || true
echo "--- DIAG: repo readiness wait log ---"
kubectl -n "${NS}" logs "${REPO_AGENT_POD}" -c overlay-readiness-wait 2>&1 || true
echo "--- DIAG: repo agent view (id, /workspace, mounts) ---"
kubectl -n "${NS}" exec "${REPO_AGENT_POD}" -c agent -- /bin/sh -c \
  'id; echo "ls -la /workspace:"; ls -la /workspace 2>&1; echo "ls -la /workspace/src:"; ls -la /workspace/src 2>&1 || true; echo "overlay mounts:"; grep -E "centaur|overlay" /proc/mounts 2>&1 || true' || true
echo "--- DIAG: repo node view (repo, upper, merged on ${KIND_CLUSTER}-control-plane) ---"
docker exec "${KIND_CLUSTER}-control-plane" sh -c \
  'echo "repo lower:"; ls -la "/var/lib/centaur/repos/'"${REPO_SESSION}"'" "/var/lib/centaur/repos/'"${REPO_SESSION}"'/src" 2>&1 || true; echo "manifest:"; cat "/var/lib/centaur/overlays/.sessions/'"${REPO_SESSION}"'.json" 2>&1 || true; echo "upper:"; find "/var/lib/centaur/overlays/'"${REPO_SESSION}"'" -maxdepth 2 -mindepth 1 -print 2>&1 || true; echo "merged:"; ls -la "/run/centaur/merged/'"${REPO_SESSION}"'" 2>&1 || true' || true

kubectl -n "${NS}" exec "${REPO_AGENT_POD}" -c agent -- /bin/sh -ceu '
  grep -q "repo lower readme" /workspace/README.md
  grep -q "pub fn lower" /workspace/src/lib.rs
  test ! -w /workspace/README.md
'
docker exec "${KIND_CLUSTER}-control-plane" sh -ceu \
  'test ! -e "/var/lib/centaur/overlays/'"${REPO_SESSION}"'/README.md";
   test ! -e "/var/lib/centaur/overlays/'"${REPO_SESSION}"'/src/lib.rs"'

kubectl -n "${NS}" exec "${REPO_AGENT_POD}" -c agent -- /bin/sh -ceu '
  echo "created through repo lower session" > /workspace/agent-created.txt
  test -f /workspace/agent-created.txt
'
docker exec "${KIND_CLUSTER}-control-plane" sh -ceu \
  'test -f "/var/lib/centaur/overlays/'"${REPO_SESSION}"'/agent-created.txt";
   test ! -e "/var/lib/centaur/overlays/'"${REPO_SESSION}"'/README.md";
   test ! -e "/var/lib/centaur/overlays/'"${REPO_SESSION}"'/src/lib.rs"'
wait_for_log "session ${REPO_SESSION}: capture: 1 upserts \\(0 streamed\\), 0 deletes" \
  "repo-lower new-file-only capture"

echo "==> [7/9] provision a multi-repo lower session and assert composed RO bases"
kubectl -n "${NS}" delete pod "${MULTI_REPO_AGENT_POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${MULTI_REPO_AGENT_POD}
  annotations:
    centaur.ai/session-id: "${MULTI_REPO_SESSION}"
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: overlays-root
      hostPath:
        path: /var/lib/centaur/overlays
        type: DirectoryOrCreate
    - name: repo-cache
      hostPath:
        path: /var/lib/centaur/repos
        type: DirectoryOrCreate
    - name: workspace
      hostPath:
        path: /run/centaur/merged/${MULTI_REPO_SESSION}
        type: DirectoryOrCreate
  initContainers:
    - name: repo-cache-seed
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          seed_repo() {
            repo="/cache/\$1"
            file="\$2"
            body="\$3"
            rm -rf "\${repo}"
            mkdir -p "\$(dirname "\${repo}")"
            mkdir -p "\${repo}"
            git init -q "\${repo}"
            git -C "\${repo}" config user.email "e2e@example.test"
            git -C "\${repo}" config user.name "e2e"
            printf '%s\n' "\${body}" > "\${repo}/\${file}"
            git -C "\${repo}" add "\${file}"
            git -C "\${repo}" commit -qm init
            chmod 0755 "\${repo}"
            chmod 0644 "\${repo}/\${file}"
          }
          seed_repo "acme/foo" "foo.txt" "foo repo base"
          seed_repo "acme/bar" "bar.txt" "bar repo base"
          ls -la /cache/acme/foo /cache/acme/bar
      volumeMounts:
        - name: repo-cache
          mountPath: /cache
    - name: overlay-manifest-writer
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/provision-overlay"]
      args:
        - "--manifest-only"
        - "--session"
        - "${MULTI_REPO_SESSION}"
        - "--repos-json"
        - '[{"repo":"acme/foo"},{"repo":"acme/bar"}]'
        - "--agent-uid"
        - "1001"
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: overlays-root
          mountPath: /var/lib/centaur/overlays
    - name: overlay-readiness-wait
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          marker="/run/centaur/merged/${MULTI_REPO_SESSION}/.centaur-workspace-ready"
          deadline=\$(( \$(date +%s) + 120 ))
          while [ ! -f "\${marker}" ]; do
            if [ "\$(date +%s)" -ge "\${deadline}" ]; then
              echo "timed out waiting for \${marker}" >&2
              exit 1
            fi
            sleep 1
          done
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: workspace
          mountPath: /run/centaur/merged/${MULTI_REPO_SESSION}
          mountPropagation: HostToContainer
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
      workingDir: /workspace
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${MULTI_REPO_AGENT_POD}" --timeout=180s

echo "--- DIAG: multi repo-cache seed log ---"
kubectl -n "${NS}" logs "${MULTI_REPO_AGENT_POD}" -c repo-cache-seed 2>&1 || true
echo "--- DIAG: multi provision-overlay manifest-writer log ---"
kubectl -n "${NS}" logs "${MULTI_REPO_AGENT_POD}" -c overlay-manifest-writer 2>&1 || true
echo "--- DIAG: multi readiness wait log ---"
kubectl -n "${NS}" logs "${MULTI_REPO_AGENT_POD}" -c overlay-readiness-wait 2>&1 || true
echo "--- DIAG: multi agent view (id, /workspace, mounts) ---"
kubectl -n "${NS}" exec "${MULTI_REPO_AGENT_POD}" -c agent -- /bin/sh -c \
  'id; echo "ls -la /workspace:"; ls -la /workspace 2>&1; echo "foo:"; ls -la /workspace/foo 2>&1 || true; echo "bar:"; ls -la /workspace/bar 2>&1 || true; echo "overlay mounts:"; grep -E "centaur|overlay" /proc/mounts 2>&1 || true' || true
echo "--- DIAG: multi node view (cache, lower, upper, merged on ${KIND_CLUSTER}-control-plane) ---"
docker exec "${KIND_CLUSTER}-control-plane" sh -c \
  'echo "repo-cache:"; find "/var/lib/centaur/repos/acme" -maxdepth 3 -mindepth 1 -print 2>&1 || true; echo "manifest:"; cat "/var/lib/centaur/overlays/.sessions/'"${MULTI_REPO_SESSION}"'.json" 2>&1 || true; echo "composed lower:"; find "/var/lib/centaur/overlay-lower/'"${MULTI_REPO_SESSION}"'.repos" -maxdepth 3 -mindepth 1 -print 2>&1 || true; echo "upper:"; find "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'" -maxdepth 3 -mindepth 1 -print 2>&1 || true; echo "merged:"; ls -la "/run/centaur/merged/'"${MULTI_REPO_SESSION}"'" 2>&1 || true' || true

kubectl -n "${NS}" exec "${MULTI_REPO_AGENT_POD}" -c agent -- /bin/sh -ceu '
  grep -q "foo repo base" /workspace/foo/foo.txt
  grep -q "bar repo base" /workspace/bar/bar.txt
  test ! -w /workspace/foo/foo.txt
  test ! -w /workspace/bar/bar.txt
'
docker exec "${KIND_CLUSTER}-control-plane" sh -ceu \
  'test ! -e "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/foo/foo.txt";
   test ! -e "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/bar/bar.txt"'

kubectl -n "${NS}" exec "${MULTI_REPO_AGENT_POD}" -c agent -- /bin/sh -ceu '
  echo "created outside composed repos" > /workspace/outside-deliverable.txt
  echo "created through multi repo lower session" > /workspace/foo/agent-created.txt
  test -f /workspace/outside-deliverable.txt
  test -f /workspace/foo/agent-created.txt
'
docker exec "${KIND_CLUSTER}-control-plane" sh -ceu \
  'test -f "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/outside-deliverable.txt";
   test -f "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/foo/agent-created.txt";
   test ! -e "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/foo/foo.txt";
   test ! -e "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/bar/bar.txt"'
echo "--- DIAG: multi node upper after nested write on ${KIND_CLUSTER}-control-plane ---"
docker exec "${KIND_CLUSTER}-control-plane" sh -c \
  'echo "upper after nested write:"; find "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'" -maxdepth 4 -mindepth 1 -print 2>&1 || true; echo "upper/foo:"; ls -la "/var/lib/centaur/overlays/'"${MULTI_REPO_SESSION}"'/foo" 2>&1 || true' || true
# The in-repo write is upper-local overlay state, but repo roots are excluded from artifact capture.
wait_for_log "session ${MULTI_REPO_SESSION}: capture: 1 upserts \\(0 streamed\\), 0 deletes" \
  "multi-repo outside-deliverable-only capture"

echo "==> [8/9] provision a hydration session and assert artifact lower is live"
kubectl -n "${NS}" delete pod "${HYDRATE_POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${HYDRATE_POD}
  annotations:
    centaur.ai/session-id: "${HYDRATE_SESSION}"
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: overlays-root
      hostPath:
        path: /var/lib/centaur/overlays
        type: DirectoryOrCreate
    - name: workspace
      hostPath:
        path: /run/centaur/merged/${HYDRATE_SESSION}
        type: DirectoryOrCreate
  initContainers:
    - name: overlay-manifest-writer
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/provision-overlay"]
      args: ["--manifest-only", "--session", "${HYDRATE_SESSION}", "--agent-uid", "1001"]
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: overlays-root
          mountPath: /var/lib/centaur/overlays
    - name: overlay-readiness-wait
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          marker="/run/centaur/merged/${HYDRATE_SESSION}/.centaur-workspace-ready"
          deadline=\$(( \$(date +%s) + 120 ))
          while [ ! -f "\${marker}" ]; do
            if [ "\$(date +%s)" -ge "\${deadline}" ]; then
              echo "timed out waiting for \${marker}" >&2
              exit 1
            fi
            sleep 1
          done
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: workspace
          mountPath: /run/centaur/merged/${HYDRATE_SESSION}
          mountPropagation: HostToContainer
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
      workingDir: /workspace
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${HYDRATE_POD}" --timeout=180s
MOCK_URL="http://${CAPTURE_SINK}.${NS}.svc.cluster.local:5678"
echo "--- DIAG: in-cluster mock /hydration-scope body (what the daemon's client sees) ---"
kubectl -n "${NS}" run mockprobe --rm -i --restart=Never --image=curlimages/curl:8.9.1 --command -- \
  curl -s "${MOCK_URL}/api/internal/sessions/${HYDRATE_SESSION}/hydration-scope" 2>&1 || true
echo
echo "--- DIAG: mock-atrium request log (the paths the daemon actually requested) ---"
kubectl -n "${NS}" logs "deploy/${CAPTURE_SINK}" --tail=80 2>&1 || true
# Assert the agent SEES the hydrated artifact directly. (We don't grep the daemon's
# one-shot "hydrate: N" log line: the per-second capture/changes poll flood truncates it
# out of the log tail before we could match it. The mounted overlay is the real proof.)
# Hydration runs before the overlay mount, which gates the pod's readiness, so the file is
# already present; retry briefly only for safety.
hydrate_ok=0
for _ in $(seq 1 30); do
  if kubectl -n "${NS}" exec "${HYDRATE_POD}" -c agent -- /bin/sh -ceu \
       'test "$(cat /workspace/shared/hydrated.md 2>/dev/null)" = "hydrated by atrium"'; then
    hydrate_ok=1
    echo "OK: agent sees the hydrated artifact at /workspace/shared/hydrated.md"
    break
  fi
  sleep 2
done
if [[ "${hydrate_ok}" != "1" ]]; then
  echo "FAIL: /workspace/shared/hydrated.md not present or wrong content" >&2
  kubectl -n "${NS}" exec "${HYDRATE_POD}" -c agent -- /bin/sh -ceu 'ls -la /workspace/shared 2>&1 || true' >&2 || true
  exit 1
fi

echo "==> [9/9] assert inbound adopt (remote edit -> merged) via pod logs"
if [[ "${NODE_SYNC_E2E_INBOUND:-0}" == "1" ]]; then
  wait_for_log "inbound: [1-9][0-9]* adopted" "inbound adopt"
else
  echo "SKIP: inbound-adopt deferred to the full-Atrium e2e (Phase 3)"
fi

echo "OK: node-sync ran as the DaemonSet pod and captured fixture + repo-lower + multi-repo pod-native overlay edits with live artifact hydration"
