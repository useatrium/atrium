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
if ! sudo docker ps -a --format '{{.Names}}' | grep -qx registry; then
  sudo docker run -d --restart=always -p "127.0.0.1:${PORT}:5000" --name registry registry:2
else
  sudo docker start registry >/dev/null 2>&1 || true
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
