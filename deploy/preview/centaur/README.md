# Shared Preview Centaur Runtime

This directory contains the first practical path for live-agent preview
environments: one Centaur runtime on a Linux VM/k3s host, wired to one active Fly
Surface preview at a time.

This is intentionally separate from the current production OVH deployment. It
reuses the same Centaur Helm chart and image shape, but disables warm pools and
points Surface and api-rs at the shared preview iron-control service.

## Why This Exists

The Fly Surface preview already works for UI, database, object storage, and
shared iron-control. It does not yet have live agents because Surface has no
`CENTAUR_BASE_URL` or `CENTAUR_API_KEY`.

Centaur is not just one HTTP process. The real `codex-app-server` workload
requires the `agent-k8s` backend, so a useful preview runtime needs Kubernetes
capacity for sandbox pods, `iron-proxy`, and `node-sync`.

## Important Limitation

`node-sync` currently reads `ATRIUM_BASE_URL` and `ATRIUM_CAPTURE_API_KEY` from
its pod environment. That means artifact capture is runtime-scoped, not
per-session or per-Surface-preview.

For this spike, treat the shared Centaur runtime as attached to one active Fly
Surface preview at a time. Re-running the deploy script repoints artifact capture
to a different preview. Live agent replies may work against a shared runtime, but
artifact capture/rendering is only expected to be correct for the currently
configured Surface preview.

Longer-term options:

- per-preview Centaur runtime;
- per-tenant node-sync pinned to preview-specific nodes;
- code change so capture routing is derived from the session/preview rather than
  one chart-global env value.

## Control Plane Rule

Surface and Centaur must use the same iron-control service. Otherwise provider
credentials are saved in one control plane while api-rs/iron-proxy asks another.

The preview values disable the in-cluster Centaur console and pass the shared
Fly preview iron-control URL/key into `api-rs` through `apiRs.extraEnv`.

## Host Prerequisites

Run this on an Ubuntu/Linux VM with:

- Docker
- k3s
- kubectl pointed at that k3s cluster
- Helm
- just
- this Atrium checkout
- the local registry mirror from `deploy/setup-registry.sh`

The k3s setup should match the OVH notes:

- disable bundled Traefik and ServiceLB before first k3s boot;
- run `deploy/setup-registry.sh`;
- run `deploy/setup-k3s.sh`.

## Deploy For One Surface Preview

First make the Fly Surface preview use a known artifact capture key. Fly secrets
are write-only, so you cannot read back the random key created by
`create-surface`.

```sh
export SURFACE_APP=atrium-prev-...
export ARTIFACT_CAPTURE_API_KEY="$(openssl rand -hex 32)"
deploy/preview/fly/previewctl.sh set-surface-capture-key "$SURFACE_APP" "$ARTIFACT_CAPTURE_API_KEY"
```

Then on the k3s Centaur VM:

```sh
export ATRIUM_PREVIEW_SURFACE_URL="https://${SURFACE_APP}.fly.dev"
export ARTIFACT_CAPTURE_API_KEY="<same value set on Surface>"
export IRON_CONTROL_BASE_URL="https://atrium-preview-iron-control.fly.dev"
export IRON_CONTROL_API_KEY="<shared preview iron-control API key>"
export IRON_CONTROL_NAMESPACE="default"

deploy/preview/centaur/deploy-shared-runtime.sh
```

The script builds/pushes Centaur images, bootstraps k8s secrets, deploys the
Helm chart, exposes api-rs as a NodePort, and prints the `CENTAUR_BASE_URL`
shape.

Wire the Fly Surface preview to Centaur:

```sh
deploy/preview/fly/previewctl.sh wire-surface-centaur \
  "$SURFACE_APP" \
  "http://<vm-public-host>:<node-port>" \
  "<LOCAL_DEV_API_KEY>"
```

## Smoke Checks

Centaur API health from the VM:

```sh
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- \
  curl -fsS http://localhost:8080/healthz
```

No-op sandbox session:

```sh
DC="kubectl exec -n centaur deploy/centaur-centaur-api-rs --"
$DC curl -fsS -X POST 'http://localhost:8080/api/session/cli%3Asmoke' \
  -H "x-api-key: <LOCAL_DEV_API_KEY>" \
  -H 'content-type: application/json' \
  -d '{"harness_type":"codex","on_harness_conflict":"restart"}'
$DC curl -fsS -X POST 'http://localhost:8080/api/session/cli%3Asmoke/execute' \
  -H "x-api-key: <LOCAL_DEV_API_KEY>" \
  -H 'content-type: application/json' \
  -d '{"input_lines":["{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"PONG\"}]}}"]}'
kubectl get pods -n centaur | grep asbx
```

Atrium smoke:

- open the Fly Surface preview;
- connect provider credentials if needed;
- send `@agent What's 10+10?`;
- then request a small static artifact app and verify it appears in the thread.

## Known Gaps

- This does not provision the VM.
- This does not open firewall/security-group access to the api-rs NodePort.
- This does not support artifact capture for multiple simultaneous Surface
  previews.
- The generated `LOCAL_DEV_API_KEY` is not printed directly; read it from the
  k8s secret on the VM when wiring Surface.
