#!/usr/bin/env bash
# deploy/redeploy.sh — rebuild + reload Atrium (Docker) and/or Centaur (k3s) on the box.
#
# Surgical and safe: only rebuilds changed images, NEVER `down -v`, pg_dumps first,
# health-gates each side, and AUTO-ROLLS-BACK to the last-good version on failure.
#
# Usage: redeploy.sh [surface|centaur|all]      (default: all)
# Env:   ATRIUM_REPO_DIR (default ~/atrium), KUBECONFIG, CENTAUR_NAMESPACE, REGISTRY_PORT
set -uo pipefail

TARGET="${1:-all}"
REPO_DIR="${ATRIUM_REPO_DIR:-$HOME/atrium}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
NS="${CENTAUR_NAMESPACE:-centaur}"
PORT="${REGISTRY_PORT:-5000}"
REG="localhost:${PORT}/library"
SURF="$REPO_DIR/surface/deploy"
STATE="$HOME/atrium-deploy"; mkdir -p "$STATE"
BK="$HOME/atrium-backups"; mkdir -p "$BK"

# surface compose (+ the box-local tunnel override if present)
DCF=(-f "$SURF/docker-compose.prod.yml")
[ -f "$SURF/docker-compose.tunnel.yml" ] && DCF+=(-f "$SURF/docker-compose.tunnel.yml")
DC=(sudo docker compose "${DCF[@]}")

log(){ echo "[$(date +%H:%M:%S)] $*"; }
die(){ echo "[$(date +%H:%M:%S)] FAILED: $*" >&2; exit 1; }

health_surface(){ curl -fsS --max-time 8 http://127.0.0.1:3001/healthz >/dev/null 2>&1; }
health_centaur(){ kubectl exec -n "$NS" deploy/centaur-centaur-api-rs -- \
  curl -fsS --max-time 8 http://localhost:8080/healthz >/dev/null 2>&1; }

backup_db(){
  local f="$BK/surface-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "pg_dump surface -> $(basename "$f")"
  "${DC[@]}" exec -T db pg_dump -U atrium atrium 2>/dev/null | gzip > "$f" \
    || log "warn: surface pg_dump failed (continuing)"
  ls -1t "$BK"/surface-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f   # keep last 14
}

# ---------- surface (Docker compose) ----------
deploy_surface(){
  log "surface: building web SPA"
  sudo docker run --rm -v "$REPO_DIR/surface":/app -w /app -e CI=true node:24-alpine \
    sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build' \
    || die "web build"
  local prev; prev=$(sudo docker image inspect deploy-server:latest -f '{{.Id}}' 2>/dev/null || true)
  [ -n "$prev" ] && sudo docker tag "$prev" deploy-server:rollback
  log "surface: build + recreate server"
  "${DC[@]}" up -d --build server || { _rollback_surface "$prev"; die "surface build/up"; }
  log "surface: health gate"
  local ok=; for i in $(seq 1 25); do health_surface && { ok=1; break; }; sleep 3; done
  [ -n "$ok" ] || { _rollback_surface "$prev"; die "surface unhealthy"; }
  log "surface: OK"
}
_rollback_surface(){
  local prev="$1"
  [ -z "$prev" ] && { log "surface: no previous image to roll back to"; return; }
  log "surface: ROLLING BACK to previous image"
  sudo docker tag deploy-server:rollback deploy-server:latest
  "${DC[@]}" up -d --no-build server || true
}

# ---------- centaur (k3s via local registry, SHA-tagged) ----------
deploy_centaur(){
  command -v just >/dev/null || die "just not found"
  local sha; sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%s)")
  log "centaur: build changed images (sha=$sha)"
  ( cd "$REPO_DIR/centaur" && DOCKER_BUILDKIT=1 just build-changed ) || die "centaur build"
  log "centaur: tag + push to registry"
  local pushed=0
  for img in centaur-api-rs centaur-iron-proxy centaur-agent centaur-node-sync; do
    sudo docker image inspect "$img:latest" >/dev/null 2>&1 || continue
    sudo docker tag "$img:latest" "$REG/$img:$sha"
    sudo docker push "$REG/$img:$sha" >/dev/null 2>&1 && pushed=$((pushed+1)) || die "push $img"
  done
  log "centaur: pushed $pushed images @ $sha; helm upgrade"
  ( cd "$REPO_DIR/centaur" && helm upgrade centaur contrib/chart -n "$NS" \
      -f contrib/chart/values.dev.yaml -f ../infra/values.local.yaml -f ../deploy/values.box.yaml \
      --set apiRs.image.tag="$sha" --set ironProxy.image.tag="$sha" \
      --set sandbox.image.tag="$sha" --set nodeSync.image.tag="$sha" ) \
    || { _rollback_centaur; die "helm upgrade"; }
  log "centaur: rollout status"
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=200s \
    || { _rollback_centaur; die "api-rs rollout"; }
  health_centaur || { _rollback_centaur; die "centaur unhealthy"; }
  echo "$sha" > "$STATE/last-good-centaur-sha"
  log "centaur: OK (last-good=$sha)"
}
_rollback_centaur(){
  local last; last=$(cat "$STATE/last-good-centaur-sha" 2>/dev/null || true)
  [ -z "$last" ] && { log "centaur: no last-good SHA to roll back to (first deploy)"; return; }
  log "centaur: ROLLING BACK to $last"
  ( cd "$REPO_DIR/centaur" && helm upgrade centaur contrib/chart -n "$NS" \
      -f contrib/chart/values.dev.yaml -f ../infra/values.local.yaml -f ../deploy/values.box.yaml \
      --set apiRs.image.tag="$last" --set ironProxy.image.tag="$last" \
      --set sandbox.image.tag="$last" --set nodeSync.image.tag="$last" ) || true
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=120s || true
}

backup_db
case "$TARGET" in
  surface) deploy_surface ;;
  centaur) deploy_centaur ;;
  all)     deploy_surface; deploy_centaur ;;
  *) die "unknown target '$TARGET' (surface|centaur|all)" ;;
esac
log "redeploy DONE ($TARGET)"
