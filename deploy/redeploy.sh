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
REPO_PARENT="$(cd "$REPO_DIR/.." && pwd)"
STATE="${ATRIUM_DEPLOY_STATE_DIR:-$REPO_PARENT/atrium-deploy}"; mkdir -p "$STATE"
BK="$HOME/atrium-backups"; mkdir -p "$BK"
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%s)")"
PNPM_STORE_DIR="${ATRIUM_PNPM_STORE_DIR:-$STATE/pnpm-store}"

DCF=(-f "$SURF/docker-compose.prod.yml")
[ -f "$SURF/docker-compose.tunnel.yml" ] && DCF+=(-f "$SURF/docker-compose.tunnel.yml")
COMPOSE_ENV_ARGS=()
[ -f "$SURF/.env" ] && COMPOSE_ENV_ARGS+=(--env-file "$SURF/.env")
DC=(sudo docker compose "${COMPOSE_ENV_ARGS[@]}" "${DCF[@]}")

if [ -z "${SURFACE_HEALTH_URL:-}" ]; then
  if [ -f "$SURF/docker-compose.tunnel.yml" ]; then
    SURFACE_HEALTH_URL="http://10.42.0.1:${SERVER_HOST_PORT:-3001}/healthz"
  else
    SURFACE_HEALTH_URL="http://127.0.0.1:${SERVER_HOST_PORT:-3001}/healthz"
  fi
fi

log(){ echo "[$(date +%H:%M:%S)] $*"; }
die(){ echo "[$(date +%H:%M:%S)] FAILED: $*" >&2; exit 1; }
health_surface(){ curl -fsS --max-time 8 "$SURFACE_HEALTH_URL" >/dev/null 2>&1; }
health_centaur(){ kubectl exec -n "$NS" deploy/centaur-centaur-api-rs -- curl -fsS --max-time 8 http://localhost:8080/healthz >/dev/null 2>&1; }

refresh_compose_cmd(){
  local env_args=()
  if [ -n "${LIVEKIT_CONFIG_FILE:-}" ]; then
    env_args+=("LIVEKIT_CONFIG_FILE=$LIVEKIT_CONFIG_FILE")
  fi
  if [ -n "${LIVEKIT_TURN_DOMAIN:-}" ]; then
    env_args+=("LIVEKIT_TURN_DOMAIN=$LIVEKIT_TURN_DOMAIN")
  fi
  if [ "${#env_args[@]}" -gt 0 ]; then
    DC=(sudo env "${env_args[@]}" docker compose "${COMPOSE_ENV_ARGS[@]}" "${DCF[@]}")
  else
    DC=(sudo docker compose "${COMPOSE_ENV_ARGS[@]}" "${DCF[@]}")
  fi
}

prepare_surface_runtime(){
  if [ -x "$SURF/prepare-livekit-config.sh" ]; then
    LIVEKIT_CONFIG_FILE="$("$SURF/prepare-livekit-config.sh")" || die "livekit config render"
    export LIVEKIT_CONFIG_FILE
    log "livekit: runtime config $LIVEKIT_CONFIG_FILE"
  fi
  refresh_compose_cmd
  mkdir -p "$PNPM_STORE_DIR" || die "create pnpm store"
}

SOURCE_CLEAN_DIRS=(
  surface/web/src
  surface/mobile/src
  surface/server/src
  surface/shared/src
  surface/centaur-client/src
  surface/e2e/tests
  surface/desktop/src
)

clean_source_strays(){
  # No -x: gitignored-by-design files remain untouched. The pathspec allowlist
  # keeps deploy/, .claude/, surface/deploy/, and repo-root files out of scope.
  local removed
  removed="$(git -C "$REPO_DIR" clean -fdn -- "${SOURCE_CLEAN_DIRS[@]}" 2>/dev/null || true)"
  if [ -n "$removed" ]; then
    log "source clean: removing untracked strays:"
    printf '%s\n' "$removed"
    git -C "$REPO_DIR" clean -fd -- "${SOURCE_CLEAN_DIRS[@]}" >/dev/null || die "source clean"
  else
    log "source clean: no untracked strays in allowlisted source dirs"
  fi
}

clean_legacy_pnpm_store(){
  local legacy="$REPO_DIR/surface/.pnpm-store"
  if [ -d "$legacy" ]; then
    log "surface: removing stale repo-local pnpm store $legacy"
    sudo rm -rf -- "$legacy" || die "remove stale pnpm store"
  fi
}

refresh_livekit_runtime(){
  local cid
  cid="$("${DC[@]}" --profile livekit ps -q livekit 2>/dev/null || true)"
  if [ -z "$cid" ]; then
    log "livekit: not running, skipping runtime config refresh"
    return
  fi
  log "livekit: refreshing runtime config"
  "${DC[@]}" --profile livekit up -d --no-build livekit || die "livekit refresh"
}

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
  clean_source_strays
  clean_legacy_pnpm_store
  log "surface: building web SPA"
  sudo docker run --rm \
    -v "$REPO_DIR/surface":/app \
    -v "$PNPM_STORE_DIR":/pnpm-store \
    -w /app \
    -e CI=true \
    node:24-alpine \
    sh -c 'corepack enable && pnpm config set store-dir /pnpm-store --global && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build' || die "web build"
  local prev; prev=$(sudo docker image inspect deploy-server:latest -f '{{.Id}}' 2>/dev/null || true)
  [ -n "$prev" ] && sudo docker tag "$prev" deploy-server:rollback
  log "surface: build + recreate server"
  "${DC[@]}" up -d --build server || { _rb_surface "$prev"; die "server build/up"; }
  log "surface: health gate $SURFACE_HEALTH_URL"
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
  changed '^centaur/services/console/' && to_build+=(console)
  # Prune-safety: rebuild any service whose local :latest image is gone — e.g. an
  # image GC / prune (see prune_images) swept the box — even when its source is
  # unchanged. The retag+push loop below reads each service's :latest, so a missing
  # one would otherwise `die`. This MUST be decided here, before that loop:
  # retagging :latest ahead of a pending rebuild would push stale code under the new
  # SHA. (Console needed this first; it now applies to every image. The SHA copy in
  # the registry is not a substitute — the retag reads the local :latest.)
  for svc in api-rs iron-proxy sandbox node-sync console; do
    sudo docker image inspect "${IMG[$svc]}:latest" >/dev/null 2>&1 && continue
    case " ${to_build[*]:-} " in *" $svc "*) : ;; *) to_build+=("$svc") ;; esac
  done
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
    --set-string apiRs.image.tag="$tag" --set-string ironProxy.image.tag="$tag" \
    --set-string sandbox.image.tag="$tag" --set-string nodeSync.image.tag="$tag" \
    --set-string console.image.tag="$tag" ); }
# Wait for the console + console-worker rollouts (skipped only when the deployment
# genuinely doesn't exist, i.e. console.enabled=false — any other kubectl failure is
# a real error, not a skip, so a transient API blip can't silently bypass the gate).
# The worker matters too: it runs the broker token-refresh jobs, so a crash-looping
# worker silently stops BYO credential refresh.
_console_rollout(){ local timeout="$1" d err
  for d in centaur-centaur-console centaur-centaur-console-worker; do
    if ! err=$(kubectl get deploy "$d" -n "$NS" 2>&1 >/dev/null); then
      case "$err" in *NotFound*) continue ;; *) return 1 ;; esac
    fi
    kubectl rollout status "deploy/$d" -n "$NS" --timeout="$timeout" || return 1
  done; }
_rb_centaur(){ local last; last=$(cat "$STATE/last-good-centaur-sha" 2>/dev/null || true)
  [ -z "$last" ] && { log "centaur: no last-good SHA (first deploy) — nothing to roll back to"; return; }
  log "centaur: ROLLING BACK to $last"; _helm "$last" || true
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=120s || true
  _console_rollout 120s || true; }

# ---------- image GC ----------
# Bound disk from per-deploy image churn. Every deploy adds SHA-tagged image copies
# + build-cache layers; without this the box grew ~a few GB/deploy across three
# stores (docker build host, k3s runtime, local registry). Runs only after a healthy
# deploy and is NON-FATAL — a prune failure must never fail a good deploy or trip the
# rollback. It deliberately keeps every `:latest` (the retag loop depends on them),
# a floor of recent build cache for fast incremental rebuilds, and the registry (the
# rollback source) untouched — the registry is bounded separately by a nightly
# deploy/registry-gc.sh (safe on registry:3; see docs/self-host-ovh.md).
# k3s image count is bounded here and by kubelet image GC (deploy/setup-k3s.sh).
BUILD_CACHE_KEEP="${BUILD_CACHE_KEEP:-20g}"
prune_images(){
  log "prune: bounding image stores (keep-cache=$BUILD_CACHE_KEEP)"
  # 1. build cache — keep a recent floor, drop the rest
  sudo docker builder prune -f --keep-storage="$BUILD_CACHE_KEEP" >/dev/null 2>&1 \
    || log "prune: warn: builder prune failed"
  # 2. old local SHA-tagged copies of our images (keep :latest; the registry retains
  #    every SHA for rollback, so dropping the local copy is safe)
  sudo docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E "^${REG}/centaur-" | grep -v ':latest$' \
    | xargs -r sudo docker rmi >/dev/null 2>&1 || true
  # 3. dangling images only — never `-a`, which would drop the :latest working tags
  sudo docker image prune -f >/dev/null 2>&1 || true
  # 4. k3s runtime store — images no running pod references (resume re-pulls from
  #    the registry). Best-effort: crictl can time out mid-sweep on a busy node.
  sudo k3s crictl rmi --prune >/dev/null 2>&1 || log "prune: k3s image prune incomplete (ok)"
  # 5. local registry — bound the third store the same way, right here rather than a
  #    separate cron. Safe to run inline: deploys are serial (no push racing the GC),
  #    the pods have already rolled to the new SHA (so it's in the keep-set), and it
  #    self-verifies in-use images afterward. Non-fatal — its own safety net logs
  #    loudly if anything regressed, but a GC hiccup must not fail a healthy deploy.
  "$REPO_DIR/deploy/registry-gc.sh" || log "prune: registry-gc reported issues (see above)"
}

prepare_surface_runtime
backup_db
case "$TARGET" in
  surface) deploy_surface ;;
  centaur) deploy_centaur ;;
  all)     deploy_surface; deploy_centaur ;;
  *) die "unknown target '$TARGET' (surface|centaur|all)" ;;
esac
refresh_livekit_runtime
echo "$SHA" > "$STATE/last-deployed-sha"
prune_images
log "redeploy DONE ($TARGET) @ $SHA"
