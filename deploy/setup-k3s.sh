#!/usr/bin/env bash
# deploy/setup-k3s.sh — ONE-TIME (idempotent): tune k3s kubelet image garbage
# collection so the container-runtime image store is bounded proactively, instead of
# only reacting once the disk hits the 85% default. On a box that fills with
# per-deploy image churn, 85% is too late — this starts reclaiming much earlier.
#
# Uses a /etc/rancher/k3s/config.yaml.d drop-in so it does NOT touch the main
# config.yaml (registry mirror, disabled traefik/servicelb, etc. stay put). k3s
# merges config.yaml.d/*.yaml over config.yaml.
#
# ⚠️  A k3s restart briefly bounces the control plane (running pods survive). Run in
#     a quiet window. Safe to re-run: it restarts k3s ONLY when the drop-in changes.
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

# Start image GC at HIGH% disk used, reclaim down to LOW%. kubelet image GC only
# removes images that no pod references (LRU) — it never touches an in-use image.
HIGH="${IMAGE_GC_HIGH:-70}"
LOW="${IMAGE_GC_LOW:-55}"
DROPIN=/etc/rancher/k3s/config.yaml.d/10-image-gc.yaml

new="$(cat <<YAML
# Managed by deploy/setup-k3s.sh — kubelet image garbage collection thresholds.
kubelet-arg:
  - "image-gc-high-threshold=${HIGH}"
  - "image-gc-low-threshold=${LOW}"
YAML
)"

if [ "$(sudo cat "$DROPIN" 2>/dev/null || true)" = "$new" ]; then
  echo "k3s image-gc drop-in already current (high=${HIGH}% low=${LOW}%) — no restart"
  exit 0
fi

sudo mkdir -p "$(dirname "$DROPIN")"
printf '%s\n' "$new" | sudo tee "$DROPIN" >/dev/null
echo "=== restart k3s to apply image-gc (high=${HIGH}% low=${LOW}%) ==="
sudo systemctl restart k3s
for i in $(seq 1 40); do
  kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready ' && { echo "node Ready"; break; }
  sleep 3
done
echo "k3s kubelet image-gc set (high=${HIGH}% low=${LOW}%)"
