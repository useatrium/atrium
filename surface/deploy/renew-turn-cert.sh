#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

compose_args=(
  -f docker-compose.prod.yml
  -f docker-compose.tunnel.yml
)

if [[ -f docker-compose.livekit-local.yml ]]; then
  compose_args+=(-f docker-compose.livekit-local.yml)
elif [[ -f docker-compose.livekit-certs.yml ]]; then
  compose_args+=(-f docker-compose.livekit-certs.yml)
fi

restart_caddy() {
  docker compose "${compose_args[@]}" --profile caddy up -d caddy
}

trap restart_caddy EXIT

renewed_marker=/var/lib/letsencrypt/atrium-turn-renewed-at
before_marker=
if [[ -f "$renewed_marker" ]]; then
  before_marker="$(cat "$renewed_marker")"
fi

# Stop Caddy for renewal, then restore it on exit.
docker compose "${compose_args[@]}" --profile caddy stop caddy

# The deploy hook runs inside the Certbot container, so it writes a marker into
# the mounted state dir. The host script restarts LiveKit if the marker changed.
docker run --rm --network host \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  certbot/certbot renew --quiet \
  --deploy-hook 'date +%s > /var/lib/letsencrypt/atrium-turn-renewed-at'

after_marker=
if [[ -f "$renewed_marker" ]]; then
  after_marker="$(cat "$renewed_marker")"
fi

if [[ "$after_marker" != "$before_marker" ]]; then
  docker compose "${compose_args[@]}" --profile livekit restart livekit
fi
