#!/usr/bin/env bash
# 2.2d-v real-pod warm-cache e2e: prove the shipped node-sync image's
# `warmcache-hydrate` init container warms the node depcache for an agent pod.
#
# Unlike the overlay pod e2e, warm-cache needs NO overlay/mountPropagation — the
# init container just reads lockfiles from the repo-cache hostPath, fetches the
# dependency store from (a mock) Atrium, and reflinks it into the depcache hostPath
# that the agent container also mounts. So this runs on plain kind (incl. Docker
# Desktop). Wired as an INFORMATIONAL CI step (continue-on-error) like the kind e2e.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
POD="${POD:-warmcache-agent}"
MOCK="${MOCK:-warmcache-mock}"
SESSION="${SESSION:-surface:warmcache-e2e}"

# Fixed lockfile body + blob, with hashes computed the same way the binary does
# (sha256 of the lockfile bytes; sha256 of the blob bytes).
LOCKFILE_BODY=$'lockfileVersion: 9.0\npackages:\n  react@18.0.0: {}\n'
BLOB_BODY='{"name":"react","version":"18.0.0"}'
LOCKFILE_HASH=$(printf '%s' "$LOCKFILE_BODY" | python3 -c 'import sys,hashlib;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
BLOB_SHA=$(printf '%s' "$BLOB_BODY" | python3 -c 'import sys,hashlib;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
echo "==> warmcache pod e2e: lockfile_hash=${LOCKFILE_HASH} blob_sha=${BLOB_SHA}"

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -

echo "==> [1/4] deploy a mock Atrium serving the session-scoped cache routes"
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${MOCK}-src
data:
  mock.py: |
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs
    LH = "${LOCKFILE_HASH}"
    BLOB_SHA = "${BLOB_SHA}"
    BLOB = b'${BLOB_BODY}'
    class H(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a): print("MOCK " + (fmt % a), flush=True)
        def _send(self, code, body, ctype="application/json"):
            if isinstance(body,(dict,list)): body=json.dumps(body).encode()
            self.send_response(code); self.send_header("Content-Type",ctype)
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            u=urlparse(self.path); q=parse_qs(u.query)
            if u.path.endswith("/cache/hydration"):
                if q.get("kind",[""])[0]=="pnpm" and q.get("lockfile_hash",[""])[0]==LH:
                    return self._send(200, {"entries":[{"path":"react/package.json","sha256":BLOB_SHA,"size_bytes":len(BLOB)}]})
                return self._send(200, {"entries":[]})
            if u.path.endswith("/cache/blob"):
                if q.get("sha256",[""])[0]==BLOB_SHA: return self._send(200, BLOB, "application/octet-stream")
                return self._send(404, {"error":"no blob"})
            return self._send(404, {"error":"unknown"})
        def do_PUT(self):
            n=int(self.headers.get("content-length","0") or "0")
            if n: self.rfile.read(n)
            return self._send(200, {"ok":True})
    ThreadingHTTPServer(("0.0.0.0",5678), H).serve_forever()
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${MOCK}
spec:
  replicas: 1
  selector: { matchLabels: { app: ${MOCK} } }
  template:
    metadata: { labels: { app: ${MOCK} } }
    spec:
      containers:
        - name: mock
          image: python:3.12-slim
          imagePullPolicy: IfNotPresent
          command: ["python","/src/mock.py"]
          ports: [{ containerPort: 5678 }]
          volumeMounts: [{ name: src, mountPath: /src, readOnly: true }]
      volumes: [{ name: src, configMap: { name: ${MOCK}-src } }]
---
apiVersion: v1
kind: Service
metadata: { name: ${MOCK} }
spec:
  selector: { app: ${MOCK} }
  ports: [{ port: 5678, targetPort: 5678 }]
YAML
kubectl -n "${NS}" rollout status "deploy/${MOCK}" --timeout=120s
MOCK_URL="http://${MOCK}.${NS}.svc.cluster.local:5678"

echo "==> [2/4] run an agent pod: repo-seed -> warmcache-hydrate init container -> agent"
kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata: { name: ${POD} }
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: repos
      hostPath: { path: /var/lib/centaur/repos, type: DirectoryOrCreate }
    - name: depcache
      hostPath: { path: /var/lib/centaur/depcache, type: DirectoryOrCreate }
    - name: cas
      hostPath: { path: /var/lib/centaur/cas, type: DirectoryOrCreate }
  initContainers:
    - name: repo-seed
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh","-ceu"]
      args:
        - |
          repo=/var/lib/centaur/repos/acme/foo
          rm -rf "\$repo"; mkdir -p "\$repo"
          git init -q "\$repo"
          git -C "\$repo" config user.email e2e@test
          git -C "\$repo" config user.name e2e
          printf 'lockfileVersion: 9.0\npackages:\n  react@18.0.0: {}\n' > "\$repo/pnpm-lock.yaml"
          git -C "\$repo" add pnpm-lock.yaml
          git -C "\$repo" commit -qm lock
      volumeMounts: [{ name: repos, mountPath: /var/lib/centaur/repos }]
    - name: warmcache-hydrate
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/warmcache-hydrate"]
      args:
        - "--session"
        - "${SESSION}"
        - "--repos-json"
        - '[{"repo":"acme/foo","ref":"HEAD"}]'
        - "--repo-cache-root"
        - "/var/lib/centaur/repos"
        - "--depcache-root"
        - "/var/cache/centaur/depcache"
        - "--cas-dir"
        - "/var/lib/centaur/cas"
      env:
        - { name: ATRIUM_URL, value: "${MOCK_URL}" }
        - { name: ARTIFACT_CAPTURE_API_KEY, value: "e2e-key" }
      volumeMounts:
        - { name: repos, mountPath: /var/lib/centaur/repos, readOnly: true }
        - { name: depcache, mountPath: /var/cache/centaur/depcache }
        - { name: cas, mountPath: /var/lib/centaur/cas }
  containers:
    - name: agent
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh","-c","sleep 3600"]
      volumeMounts: [{ name: depcache, mountPath: /var/cache/centaur/depcache }]
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${POD}" --timeout=180s

echo "--- DIAG: warmcache-hydrate init log ---"
kubectl -n "${NS}" logs "${POD}" -c warmcache-hydrate 2>&1 || true
echo "--- DIAG: mock request log ---"
kubectl -n "${NS}" logs "deploy/${MOCK}" --tail=40 2>&1 || true

echo "==> [3/4] assert the agent sees the warmed pnpm store"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
  f=/var/cache/centaur/depcache/pnpm-store/react/package.json
  test -f "$f"
  grep -q "\"name\":\"react\"" "$f"
'
echo "    OK: agent sees /var/cache/centaur/depcache/pnpm-store/react/package.json"

echo "==> [4/4] cleanup"
kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=false || true
kubectl -n "${NS}" delete deploy "${MOCK}" --ignore-not-found --wait=false || true
echo "OK: warmcache-hydrate init container warmed the depcache for the agent (real pod)"
