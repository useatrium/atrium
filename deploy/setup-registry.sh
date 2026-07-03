#!/usr/bin/env bash
# deploy/setup-registry.sh — ONE-TIME: stand up a local image registry and point
# k3s at it, so Centaur deploys push SHA-tagged images and can roll back by tag.
#
# ⚠️  Writes /etc/rancher/k3s/registries.yaml and restarts k3s, which bounces
#     EVERY pod on the node (agent sandboxes included). Run in a quiet window.
set -euo pipefail
PORT="${REGISTRY_PORT:-5000}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

echo "=== local registry container (127.0.0.1:${PORT}) ==="
# registry:3 (CNCF distribution v3) + deletes enabled so deploy/registry-gc.sh can
# reclaim safely. v3's garbage-collect correctly follows OCI image-index → blob
# references (POC-verified); registry:2's did NOT and deleted in-use blobs, so we do
# not run GC on v2. v3 reads the existing v2 on-disk layout, so an in-place upgrade
# just recreates the container on the same named volume. Config path in v3 is
# /etc/distribution/config.yml (was /etc/docker/registry/config.yml in v2).
REG_IMAGE="${REGISTRY_IMAGE:-registry:3}"
if ! sudo docker ps -a --format '{{.Names}}' | grep -qx registry; then
  sudo docker run -d --restart=always -p "127.0.0.1:${PORT}:5000" --name registry \
    -e REGISTRY_STORAGE_DELETE_ENABLED=true -v atrium-registry:/var/lib/registry "$REG_IMAGE"
else
  sudo docker start registry >/dev/null 2>&1 || true
  # Upgrade an existing registry to v3 with deletes on, preserving its volume:
  if ! sudo docker inspect registry -f '{{.Config.Image}} {{.Config.Env}}' 2>/dev/null \
       | grep -q "registry:3.*REGISTRY_STORAGE_DELETE_ENABLED=true"; then
    echo "  upgrading registry -> $REG_IMAGE (deletes enabled), preserving volume"
    vol=$(sudo docker inspect registry -f '{{range .Mounts}}{{.Name}}{{end}}')
    sudo docker rm -f registry >/dev/null
    sudo docker run -d --restart=always -p "127.0.0.1:${PORT}:5000" --name registry \
      -e REGISTRY_STORAGE_DELETE_ENABLED=true -v "${vol:-atrium-registry}:/var/lib/registry" "$REG_IMAGE"
  fi
fi

echo "=== k3s registries.yaml (HTTP mirror for localhost:${PORT} only; docker.io untouched) ==="
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<YAML
mirrors:
  "localhost:${PORT}":
    endpoint:
      - "http://localhost:${PORT}"
YAML

echo "=== restart k3s (one-time all-pods bounce) ==="
sudo systemctl restart k3s
for i in $(seq 1 40); do
  kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready ' && { echo "node Ready"; break; }
  sleep 3
done
echo "registry + k3s mirror ready"
