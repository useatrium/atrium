#!/usr/bin/env bash
# deploy/redeploy.sh — rebuild + reload Atrium (Docker) and/or Centaur (k3s) on the box.
#
# Surgical and safe: CONTENT-AWARE (only rebuilds images whose source actually
# changed since the last deploy), NEVER `down -v`, pg_dumps first, health-gates each
# side, and AUTO-ROLLS-BACK to the last-good version on failure.
#
# Usage: redeploy.sh [surface|centaur|all]      (default: all)
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
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%s)")"

DCF=(-f "$SURF/docker-compose.prod.yml")
[ -f "$SURF/docker-compose.tunnel.yml" ] && DCF+=(-f "$SURF/docker-compose.tunnel.yml")
DC=(sudo docker compose "${DCF[@]}")

log(){ echo "[$(date +%H:%M:%S)] $*"; }
die(){ echo "[$(date +%H:%M:%S)] FAILED: $*" >&2; exit 1; }
health_surface(){ curl -fsS --max-time 8 http://127.0.0.1:3001/healthz >/dev/null 2>&1; }
health_centaur(){ kubectl exec -n "$NS" deploy/centaur-centaur-api-rs -- curl -fsS --max-time 8 http://localhost:8080/healthz >/dev/null 2>&1; }

# ---- content-aware change detection (last-deployed SHA -> HEAD) ----
LAST="$(cat "$STATE/last-deployed-sha" 2>/dev/null || true)"
if [ -n "$LAST" ] && git -C "$REPO_DIR" cat-file -e "${LAST}^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO_DIR" diff --name-only "$LAST" HEAD)"
  FIRST=0
else
  CHANGED=""; FIRST=1   # first deploy / unknown baseline -> rebuild everything
fi
changed(){ [ "$FIRST" = 1 ] && return 0; grep -qE "$1" <<<"$CHANGED"; }

need_surface=0; need_apirs=0; need_ironproxy=0; need_agent=0
changed '^surface/'                                                   && need_surface=1
changed '^centaur/services/(api-rs|workflow-python)/|^centaur/Cargo'  && need_apirs=1
changed '^centaur/services/iron-proxy/'                               && need_ironproxy=1
changed '^centaur/services/sandbox/|^centaur/(tools|workflows|\.agents)/' && need_agent=1
# node-sync builds from the api-rs context, so it tracks api-rs
need_nodesync=$need_apirs

backup_db(){
  local f="$BK/surface-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "pg_dump surface -> $(basename "$f")"
  "${DC[@]}" exec -T db pg_dump -U atrium atrium 2>/dev/null | gzip > "$f" || log "warn: pg_dump failed (continuing)"
  ls -1t "$BK"/surface-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
}

# ---------- surface ----------
deploy_surface(){
  if [ "$need_surface" != 1 ]; then log "surface: no source change, skipping"; return; fi
  log "surface: building web SPA"
  sudo docker run --rm -v "$REPO_DIR/surface":/app -w /app -e CI=true node:24-alpine \
    sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build' || die "web build"
  local prev; prev=$(sudo docker image inspect deploy-server:latest -f '{{.Id}}' 2>/dev/null || true)
  [ -n "$prev" ] && sudo docker tag "$prev" deploy-server:rollback
  log "surface: build + recreate server"
  "${DC[@]}" up -d --build server || { _rb_surface "$prev"; die "server build/up"; }
  local ok=; for i in $(seq 1 25); do health_surface && { ok=1; break; }; sleep 3; done
  [ -n "$ok" ] || { _rb_surface "$prev"; die "surface unhealthy"; }
  log "surface: OK"
}
_rb_surface(){ local prev="$1"; [ -z "$prev" ] && return
  log "surface: ROLLING BACK to previous image"
  sudo docker tag deploy-server:rollback deploy-server:latest; "${DC[@]}" up -d --no-build server || true; }

# ---------- centaur ----------
declare -A IMG=([api-rs]=centaur-api-rs [iron-proxy]=centaur-iron-proxy [sandbox]=centaur-agent [node-sync]=centaur-node-sync [console]=centaur-console)
deploy_centaur(){
  command -v just >/dev/null || die "just not found"
  local to_build=()
  [ "$need_apirs" = 1 ]     && to_build+=(api-rs)
  [ "$need_ironproxy" = 1 ] && to_build+=(iron-proxy)
  [ "$need_agent" = 1 ]     && to_build+=(sandbox)
  [ "$need_nodesync" = 1 ]  && to_build+=(node-sync)
  # console (iron-control): rebuilt when its source changes, or when the local image
  # is missing entirely (pruned box). The build MUST be decided here, before the
  # retag loop — retagging :latest ahead of a pending rebuild would push the OLD
  # console under the new SHA and silently deploy stale code with a fresh tag.
  if [ "$FIRST" = 1 ] || changed '^centaur/services/console/' \
     || ! sudo docker image inspect centaur-console:latest >/dev/null 2>&1; then
    to_build+=(console)
  fi
  log "centaur: rebuild=[${to_build[*]:-none}] sha=$SHA"
  for svc in "${to_build[@]:-}"; do [ -z "$svc" ] && continue
    ( cd "$REPO_DIR/centaur" && DOCKER_BUILDKIT=1 just build-one "$svc" ) || die "build $svc"; done
  # tag+push every image at $SHA (rebuilt = new; unchanged = cheap retag of existing
  # :latest). Console is SHA-pinned like the rest so a helm upgrade actually rolls
  # its pods (a same-string :latest spec never re-pulls) and rollback can address
  # the previous console build. Invariant: last-good-centaur-sha is written only
  # after a successful deploy, and that run pushed console:$SHA first — so the
  # rollback tag always exists in the registry.
  for svc in api-rs iron-proxy sandbox node-sync console; do
    local img=${IMG[$svc]}
    sudo docker image inspect "$img:latest" >/dev/null 2>&1 || die "$img:latest missing"
    sudo docker tag "$img:latest" "$REG/$img:$SHA"
    sudo docker push "$REG/$img:$SHA" >/dev/null 2>&1 || die "push $img"
  done
  log "centaur: helm upgrade @ $SHA"
  _helm "$SHA" || { _rb_centaur; die "helm upgrade"; }
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=200s || { _rb_centaur; die "rollout"; }
  _console_rollout 180s || { _rb_centaur; die "console rollout"; }
  health_centaur || { _rb_centaur; die "centaur unhealthy"; }
  echo "$SHA" > "$STATE/last-good-centaur-sha"
  log "centaur: OK (last-good=$SHA)"
}
_helm(){ local tag="$1"; ( cd "$REPO_DIR/centaur" && helm upgrade centaur contrib/chart -n "$NS" \
    -f contrib/chart/values.dev.yaml -f ../infra/values.local.yaml -f ../deploy/values.box.yaml \
    --set apiRs.image.tag="$tag" --set ironProxy.image.tag="$tag" \
    --set sandbox.image.tag="$tag" --set nodeSync.image.tag="$tag" \
    --set console.image.tag="$tag" ); }
# Wait for the console + console-worker rollouts (no-op when console.enabled=false
# leaves no deployments). The worker matters too: it runs the broker token-refresh
# jobs, so a crash-looping worker silently stops BYO credential refresh.
_console_rollout(){ local timeout="$1" d
  for d in centaur-centaur-console centaur-centaur-console-worker; do
    kubectl get deploy "$d" -n "$NS" >/dev/null 2>&1 || continue
    kubectl rollout status "deploy/$d" -n "$NS" --timeout="$timeout" || return 1
  done; }
_rb_centaur(){ local last; last=$(cat "$STATE/last-good-centaur-sha" 2>/dev/null || true)
  [ -z "$last" ] && { log "centaur: no last-good SHA (first deploy) — nothing to roll back to"; return; }
  log "centaur: ROLLING BACK to $last"; _helm "$last" || true
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=120s || true
  _console_rollout 120s || true; }

backup_db
case "$TARGET" in
  surface) deploy_surface ;;
  centaur) deploy_centaur ;;
  all)     deploy_surface; deploy_centaur ;;
  *) die "unknown target '$TARGET' (surface|centaur|all)" ;;
esac
echo "$SHA" > "$STATE/last-deployed-sha"
log "redeploy DONE ($TARGET) @ $SHA"
