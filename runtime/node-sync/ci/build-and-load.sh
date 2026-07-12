#!/usr/bin/env bash
# R3 — build the node-sync image and load it into a kind cluster so the daemon can
# run as the REAL DaemonSet pod (today's distributed-daemon-e2e.sh copies a bare
# binary onto the node instead). Pairs with pod-native-e2e.sh.
#
# NOT-VALIDATED-ON-MACOS: needs a real Linux Docker daemon + kind on overlayfs.
# Docker Desktop's privileged/overlay semantics are not equivalent; run on a GHA
# ubuntu runner or a real Linux host. See docs/archive/notes/sync-hardening-plan.md.
set -euo pipefail

# The node-sync Dockerfile uses a `# syntax=` directive and BuildKit cache mounts,
# so the build requires BuildKit. GHA's Docker defaults to it, but make it explicit
# so this build site never regresses to the legacy builder.
export DOCKER_BUILDKIT=1

IMAGE="${IMAGE:-centaur-node-sync:e2e}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
# The crate is its own cargo workspace; the Dockerfile builds from the crate root.
CRATE_DIR="${CRATE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "==> building ${IMAGE} from ${CRATE_DIR}"
docker build -f "${CRATE_DIR}/Dockerfile" -t "${IMAGE}" "${CRATE_DIR}"

echo "==> loading ${IMAGE} into kind cluster '${KIND_CLUSTER}'"
kind load docker-image "${IMAGE}" --name "${KIND_CLUSTER}"

echo "==> verifying the image is present on the node"
docker exec "${KIND_CLUSTER}-control-plane" crictl images | grep -E "centaur-node-sync" \
  || { echo "image not found on node" >&2; exit 1; }
echo "OK: ${IMAGE} loaded into kind/${KIND_CLUSTER}"
