#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_PARENT="$(cd "$REPO_DIR/.." && pwd)"
STATE_DIR="${ATRIUM_DEPLOY_STATE_DIR:-$REPO_PARENT/atrium-deploy}"
OUT_DIR="${ATRIUM_SURFACE_STATE_DIR:-$STATE_DIR/surface}"
OUT_FILE="${LIVEKIT_CONFIG_FILE:-$OUT_DIR/livekit.yaml}"

read_env_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    $0 ~ /^[[:space:]]*($|#)/ { next }
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if (($0 ~ /^".*"$/) || ($0 ~ /^\047.*\047$/)) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print
      exit
    }
  ' "$file"
}

domain="${LIVEKIT_TURN_DOMAIN:-}"
if [[ -z "$domain" && -f "$SCRIPT_DIR/.env" ]]; then
  domain="$(read_env_value LIVEKIT_TURN_DOMAIN "$SCRIPT_DIR/.env" || true)"
fi
domain="${domain:-turn.example.com}"

if [[ ! "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "invalid LIVEKIT_TURN_DOMAIN: $domain" >&2
  exit 1
fi

# The webhook api_key must match the LIVEKIT_API_KEY the server signs/verifies
# with, so inject it here (same env the compose file feeds LIVEKIT_KEYS). Empty
# is fine: a keyless LiveKit means calls are disabled and the livekit profile is
# opt-in, so the rendered config is never loaded. LiveKit keys are alphanumeric,
# so no awk replacement-string escaping is needed.
apikey="${LIVEKIT_API_KEY:-}"
if [[ -z "$apikey" && -f "$SCRIPT_DIR/.env" ]]; then
  apikey="$(read_env_value LIVEKIT_API_KEY "$SCRIPT_DIR/.env" || true)"
fi

# The webhook target is the address the server is actually published on, which
# the tunnel topology rebinds off loopback (redeploy.sh derives it and exports
# LIVEKIT_WEBHOOK_URL). Default to loopback:3001 for plain/manual runs.
weburl="${LIVEKIT_WEBHOOK_URL:-}"
if [[ -z "$weburl" && -f "$SCRIPT_DIR/.env" ]]; then
  weburl="$(read_env_value LIVEKIT_WEBHOOK_URL "$SCRIPT_DIR/.env" || true)"
fi
weburl="${weburl:-http://127.0.0.1:3001/api/calls/webhook}"

mkdir -p "$OUT_DIR"
tmp="$(mktemp "$OUT_DIR/livekit.yaml.XXXXXX")"

awk -v domain="$domain" -v apikey="$apikey" -v weburl="$weburl" '
  { gsub(/__LIVEKIT_API_KEY__/, apikey); gsub(/__LIVEKIT_WEBHOOK_URL__/, weburl) }
  /^turn:[[:space:]]*$/ {
    in_turn = 1
    print
    next
  }
  in_turn && /^[^[:space:]#]/ {
    in_turn = 0
  }
  in_turn && /^[[:space:]]*domain:[[:space:]]*/ {
    print "  domain: " domain
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) {
      exit 42
    }
  }
' "$SCRIPT_DIR/livekit.yaml" > "$tmp" || {
  status=$?
  rm -f "$tmp"
  if [[ "$status" -eq 42 ]]; then
    echo "could not replace turn.domain in $SCRIPT_DIR/livekit.yaml" >&2
  fi
  exit "$status"
}

chmod 0644 "$tmp"
mv "$tmp" "$OUT_FILE"
printf '%s\n' "$OUT_FILE"
