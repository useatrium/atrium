#!/usr/bin/env bash
# Flip the local Centaur deployment from the Phase-0 LLM mock to the real
# Anthropic API. Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./infra/use-real-anthropic.sh
# Then verify with:  cd ~/Code/centaur && just smoke claude-code
set -euo pipefail

: "${ANTHROPIC_API_KEY:?export ANTHROPIC_API_KEY first}"
NS="${CENTAUR_NAMESPACE:-centaur}"
HERE="$(cd "$(dirname "$0")" && pwd)"

case "$ANTHROPIC_API_KEY" in
  sk-ant-*) ;;
  *) echo "WARNING: key does not look like an Anthropic key (sk-ant-...)" >&2 ;;
esac

# 1. Put the real key in the env-mode secret store.
kubectl -n "$NS" patch secret centaur-infra-env --type merge \
  -p "{\"stringData\":{\"ANTHROPIC_API_KEY\":\"${ANTHROPIC_API_KEY}\"}}"

# 2. Drop the mock base-url override (keep everything else).
TMP_VALUES="$(mktemp)"
sed '/ANTHROPIC_BASE_URL/d; /Mock serves a cert/d; /https through iron-proxy/d' \
  "$HERE/values.local.yaml" > "$TMP_VALUES"

# 3. Redeploy and cycle pods so sandboxes/proxies pick up the change.
helm upgrade --install centaur "$HOME/Code/centaur/contrib/chart" -n "$NS" \
  -f "$HOME/Code/centaur/contrib/chart/values.dev.yaml" -f "$TMP_VALUES"
kubectl -n "$NS" delete pods -l 'centaur.ai/managed=true' --wait=false || true
kubectl -n "$NS" rollout status deploy/centaur-centaur-api --timeout=180s

echo "Done. Run a real smoke:  cd ~/Code/centaur && just smoke claude-code"
echo "To go back to the mock:  helm upgrade ... -f $HERE/values.local.yaml (original file)"
