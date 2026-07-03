#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
REPO_DIR="${ATRIUM_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REPO_PARENT="$(cd "$REPO_DIR/.." && pwd)"
export ATRIUM_DEPLOY_STATE_DIR="${ATRIUM_DEPLOY_STATE_DIR:-$REPO_PARENT/atrium-deploy}"

if [[ -x "$SCRIPT_DIR/prepare-livekit-config.sh" ]]; then
  LIVEKIT_CONFIG_FILE="$("$SCRIPT_DIR/prepare-livekit-config.sh")"
  export LIVEKIT_CONFIG_FILE
fi

compose_args=()
if [[ -f .env ]]; then
  compose_args+=(--env-file .env)
fi
compose_args+=(-f docker-compose.prod.yml)

if [[ -f docker-compose.tunnel.yml ]]; then
  compose_args+=(-f docker-compose.tunnel.yml)
fi

docker_compose() {
  ${DOCKER_BIN:-docker} compose "${compose_args[@]}" "$@"
}

docker_run() {
  ${DOCKER_BIN:-docker} run "$@"
}

restart_caddy() {
  docker_compose --profile caddy up -d caddy
}

trap restart_caddy EXIT

renewed_marker=/var/lib/letsencrypt/atrium-turn-renewed-at
before_marker=
if [[ -f "$renewed_marker" ]]; then
  before_marker="$(cat "$renewed_marker")"
fi

# Stop Caddy for renewal, then restore it on exit.
docker_compose --profile caddy stop caddy

# The deploy hook runs inside the Certbot container, so it writes a marker into
# the mounted state dir. The host script restarts LiveKit if the marker changed.
docker_run --rm --network host \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  certbot/certbot renew --quiet \
  --deploy-hook 'date +%s > /var/lib/letsencrypt/atrium-turn-renewed-at'

after_marker=
if [[ -f "$renewed_marker" ]]; then
  after_marker="$(cat "$renewed_marker")"
fi

if [[ "$after_marker" != "$before_marker" ]]; then
  docker_compose --profile livekit restart livekit
fi
