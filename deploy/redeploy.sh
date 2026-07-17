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

# Serialize deploys on this box. The GitHub-triggered deploy (deploy.yml, guarded
# by `concurrency: deploy-box`) and a documented manual `redeploy.sh` run on the
# box otherwise race: both `git reset --hard` the same checkout and stomp the
# state files, and prune_images explicitly assumes deploys are serial. Re-exec
# once under an flock; a second caller waits up to the timeout, then fails loudly
# rather than running concurrently. Degrades to unlocked if flock is unavailable.
if [ -z "${_ATRIUM_DEPLOY_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  exec env _ATRIUM_DEPLOY_LOCKED=1 \
    flock -w "${ATRIUM_DEPLOY_LOCK_WAIT:-1200}" "$STATE/deploy.lock" "$0" "$@"
fi

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

# LiveKit (network_mode: host) must reach the server's call-reaping webhook at
# the address the server is actually published on — which the tunnel override
# rebinds to 10.42.0.1. Derive it from the same signal as the health URL so the
# two never drift; prepare-livekit-config.sh substitutes it into livekit.yaml.
if [ -z "${LIVEKIT_WEBHOOK_URL:-}" ]; then
  if [ -f "$SURF/docker-compose.tunnel.yml" ]; then
    LIVEKIT_WEBHOOK_URL="http://10.42.0.1:${SERVER_HOST_PORT:-3001}/api/calls/webhook"
  else
    LIVEKIT_WEBHOOK_URL="http://127.0.0.1:${SERVER_HOST_PORT:-3001}/api/calls/webhook"
  fi
fi
export LIVEKIT_WEBHOOK_URL

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
  LIVEKIT_CONFIG_CHANGED=0
  if [ -x "$SURF/prepare-livekit-config.sh" ]; then
    # Hash the previously-rendered config so we only bounce LiveKit when the
    # rendered content actually changes (Compose won't recreate a container for
    # a bind-mounted file's content change, and LiveKit only reads its config at
    # startup — so without this a config change silently never reaches it).
    local prev_sum="" new_sum=""
    prev_sum="$(sha256sum "$STATE/surface/livekit.yaml" 2>/dev/null | awk '{print $1}')"
    LIVEKIT_CONFIG_FILE="$("$SURF/prepare-livekit-config.sh")" || die "livekit config render"
    export LIVEKIT_CONFIG_FILE
    new_sum="$(sha256sum "$LIVEKIT_CONFIG_FILE" 2>/dev/null | awk '{print $1}')"
    [ "$prev_sum" != "$new_sum" ] && LIVEKIT_CONFIG_CHANGED=1
    log "livekit: runtime config $LIVEKIT_CONFIG_FILE (changed=$LIVEKIT_CONFIG_CHANGED)"
  fi
  export LIVEKIT_CONFIG_CHANGED
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
  # Plain `up -d` will NOT recreate the container when only the mounted config's
  # content changed, so force a recreate in that case to make LiveKit re-read it.
  # Skip the bounce (and the call drop it causes) when the config is unchanged.
  if [ "${LIVEKIT_CONFIG_CHANGED:-0}" = "1" ]; then
    log "livekit: config changed — recreating to reload"
    "${DC[@]}" --profile livekit up -d --force-recreate --no-build livekit || die "livekit refresh"
  else
    log "livekit: config unchanged — ensuring running, no recreate"
    "${DC[@]}" --profile livekit up -d --no-build livekit || die "livekit refresh"
  fi
}

# ---- content-aware change detection (last-deployed SHA -> HEAD) ----
# Baselines are tracked PER SIDE. A partial deploy (`redeploy.sh surface`) must
# not advance the centaur baseline, or a later `centaur`/`all` still at the same
# SHA would diff empty, see "no changes", and silently never rebuild pending
# centaur images (symmetric for the surface side). Migrate the legacy single-file
# baseline to both sides on the first run after this change.
LAST_SURFACE="$(cat "$STATE/last-deployed-sha-surface" 2>/dev/null || true)"
LAST_CENTAUR="$(cat "$STATE/last-deployed-sha-centaur" 2>/dev/null || true)"
if [ -z "$LAST_SURFACE$LAST_CENTAUR" ]; then
  _legacy="$(cat "$STATE/last-deployed-sha" 2>/dev/null || true)"
  [ -n "$_legacy" ] && { LAST_SURFACE="$_legacy"; LAST_CENTAUR="$_legacy"; }
fi
_valid_base(){ [ -n "$1" ] && git -C "$REPO_DIR" cat-file -e "${1}^{commit}" 2>/dev/null; }
_changed_since(){ _valid_base "$1" && git -C "$REPO_DIR" diff --name-only "$1" HEAD; }
CHANGED_SURFACE="$(_changed_since "$LAST_SURFACE")"
CHANGED_CENTAUR="$(_changed_since "$LAST_CENTAUR")"
# Unknown/invalid baseline -> rebuild everything on that side.
FIRST_SURFACE=0; _valid_base "$LAST_SURFACE" || FIRST_SURFACE=1
FIRST_CENTAUR=0; _valid_base "$LAST_CENTAUR" || FIRST_CENTAUR=1
changed_surface(){ [ "$FIRST_SURFACE" = 1 ] && return 0; grep -qE "$1" <<<"$CHANGED_SURFACE"; }
changed_centaur(){ [ "$FIRST_CENTAUR" = 1 ] && return 0; grep -qE "$1" <<<"$CHANGED_CENTAUR"; }

# The centaur patterns must mirror each image's Docker COPY context, or a change
# to a copied dir ships stale code: the agent image bakes centaur_sdk/ and
# services/workflow-python/ (Dockerfile.agent), and api-rs bakes tools/ and
# workflows/ (services/api-rs/Dockerfile) — so both dirs trigger BOTH images.
need_surface=0; need_apirs=0; need_ironproxy=0; need_agent=0; need_nodesync=0
changed_surface '^surface/'                                          && need_surface=1
changed_centaur '^centaur/services/(api-rs|workflow-python)/|^centaur/(tools|workflows)/|^centaur/Cargo'  && need_apirs=1
changed_centaur '^centaur/services/iron-proxy/'                      && need_ironproxy=1
changed_centaur '^centaur/services/(sandbox|workflow-python)/|^centaur/(tools|workflows|\.agents|harness|crates|centaur_sdk)/' && need_agent=1
# node-sync is Atrium-owned and lives outside the subtree (its own workspace)
changed_centaur '^runtime/node-sync/'                               && need_nodesync=1

backup_db(){
  local f="$BK/surface-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "pg_dump surface -> $(basename "$f")"
  "${DC[@]}" exec -T db pg_dump -U atrium atrium 2>/dev/null | gzip > "$f" || log "warn: pg_dump failed (continuing)"
  ls -1t "$BK"/surface-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
}

# ---------- surface ----------
deploy_surface(){
  if [ "$need_surface" != 1 ]; then
    # No rebuild needed — but "skip" must never leave a down stack down (the
    # 2026-07-09 outage: server crashed, box rebooted, and a no-change deploy
    # "succeeded" while prod stayed dead). Ensure it's up and healthy.
    if health_surface; then log "surface: no source change, healthy, skipping"; return; fi
    log "surface: no source change but UNHEALTHY — starting existing image"
    "${DC[@]}" up -d --no-build server || die "surface ensure-up"
    local up=; for i in $(seq 1 25); do health_surface && { up=1; break; }; sleep 3; done
    [ -n "$up" ] || die "surface still unhealthy after ensure-up"
    log "surface: OK (ensure-up, no rebuild)"
    return
  fi
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
  _secret_preflight
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
  # Prod build config, overriding the Justfile's dev-convenience defaults:
  #  - RUST_BUILD_PROFILE=release: the api-rs/agent/node-sync Dockerfiles default
  #    their ARG to release, but centaur/Justfile defaults the env override to
  #    "debug" for fast local iteration. Prod must ship optimized binaries.
  #  - CENTAUR_AGENT_DOCKERFILE: build the slimmed Atrium agent image (upstream's
  #    services/sandbox/Dockerfile is left untouched for merge-clean subtree pulls).
  export RUST_BUILD_PROFILE=release
  export CENTAUR_AGENT_DOCKERFILE=services/sandbox/Dockerfile.agent
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
    # Keep the registry :latest alias current too — deploys pin SHA tags, but a
    # stale :latest reads as a failed image push during debugging.
    sudo docker tag "$img:latest" "$REG/$img:latest"
    sudo docker push "$REG/$img:latest" >/dev/null 2>&1 || die "push $img:latest"
  done
  log "centaur: helm upgrade @ $SHA"
  _helm "$SHA" || { _rb_centaur; die "helm upgrade"; }
  kubectl rollout status deploy/centaur-centaur-api-rs -n "$NS" --timeout=200s || { _rb_centaur; die "rollout"; }
  _console_rollout 180s || { _rb_centaur; die "console rollout"; }
  health_centaur || { _rb_centaur; die "centaur unhealthy"; }
  echo "$SHA" > "$STATE/last-good-centaur-sha"
  log "centaur: OK (last-good=$SHA)"
}
# Template/upgrade the chart from an explicit source tree (default: the live
# checkout). Rollback passes the last-good tree so the chart matches the image
# tags. infra/values.local.yaml is box-local (untracked), so it always comes
# from the live checkout.
_helm(){ local tag="$1" root="${2:-$REPO_DIR}"; ( cd "$root/centaur" && helm upgrade centaur contrib/chart -n "$NS" \
    -f contrib/chart/values.dev.yaml -f "$REPO_DIR/infra/values.local.yaml" -f "$root/deploy/values.box.yaml" \
    --set-string apiRs.image.tag="$tag" --set-string ironProxy.image.tag="$tag" \
    --set-string sandbox.image.tag="$tag" --set-string nodeSync.image.tag="$tag" \
    --set-string console.image.tag="$tag" ); }
# Fail fast (before the multi-minute image builds) when the chart references a
# secret key that isn't provisioned in the cluster. A missing key otherwise
# surfaces only at rollout time as CreateContainerConfigError — and since the
# failure is provisioning, not code, the rollback can't fix it either
# (2026-07-11: a new chart-required CENTAUR_JWT_SIGNING_SECRET wedged the
# rollout for 20h). Checks every rendered secretKeyRef name/key pair and every
# envFrom secretRef secret.
_secret_preflight(){
  local rendered refs missing=0 name key
  rendered="$(cd "$REPO_DIR/centaur" && helm template centaur contrib/chart -n "$NS" \
    -f contrib/chart/values.dev.yaml -f "$REPO_DIR/infra/values.local.yaml" -f "$REPO_DIR/deploy/values.box.yaml" \
    --set-string apiRs.image.tag=preflight --set-string ironProxy.image.tag=preflight \
    --set-string sandbox.image.tag=preflight --set-string nodeSync.image.tag=preflight \
    --set-string console.image.tag=preflight 2>&1)" || die "helm template failed in secret preflight: $(tail -n 3 <<<"$rendered")"
  refs="$(awk '
    function flush() { if (n != "" && k != "") print n "\t" k; inkeyref = 0; n = ""; k = "" }
    /secretKeyRef:/ { flush(); inkeyref = 1; next }
    inkeyref && $1 == "name:" { n = $2; gsub(/"/, "", n); next }
    inkeyref && $1 == "key:"  { k = $2; gsub(/"/, "", k); next }
    inkeyref { flush() }
    /- secretRef:/ { insecref = 1; next }
    insecref { if ($1 == "name:") { s = $2; gsub(/"/, "", s); print s "\t-" }; insecref = 0 }
    END { flush() }
  ' <<<"$rendered" | sort -u)"
  [ -n "$refs" ] || die "secret preflight parsed no secret refs — parser or chart layout changed, refusing to proceed blind"
  while IFS=$'\t' read -r name key; do
    [ -z "$name" ] && continue
    if [ "$key" = "-" ]; then
      kubectl -n "$NS" get secret "$name" >/dev/null 2>&1 \
        || { log "centaur: PREFLIGHT missing secret: $name"; missing=1; }
    else
      kubectl -n "$NS" get secret "$name" -o "jsonpath={.data['$key']}" 2>/dev/null | grep -q . \
        || { log "centaur: PREFLIGHT missing secret key: $name/$key"; missing=1; }
    fi
  done <<<"$refs"
  [ "$missing" = 1 ] && die "secret preflight: provision the keys above (see centaur/contrib/scripts/bootstrap-k8s-secrets.sh), then redeploy"
  log "centaur: secret preflight OK ($(wc -l <<<"$refs" | tr -d ' ') refs)"
}
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
  log "centaur: ROLLING BACK to $last"
  # Roll back with the last-good CHART, not just last-good image tags:
  # re-templating the current checkout's chart here re-applies the very chart
  # change that may have caused the failure, pinning it over old images — a
  # chart/image skew that can never converge (2026-07-11: a chart-only env
  # rename crashed the last-good binary during rollback). Materialize the
  # chart + tracked values at $last; infra/values.local.yaml stays live-checkout
  # (box-local, untracked).
  local rbroot=""
  if git -C "$REPO_DIR" cat-file -e "${last}^{commit}" 2>/dev/null; then
    rbroot="$(mktemp -d)"
    if git -C "$REPO_DIR" archive "$last" centaur/contrib deploy/values.box.yaml | tar -x -C "$rbroot"; then
      # Packaged chart dependencies (charts/*.tgz) are gitignored fetch
      # artifacts, so the archive lacks them; borrow the live checkout's.
      cp "$REPO_DIR"/centaur/contrib/chart/charts/*.tgz "$rbroot/centaur/contrib/chart/charts/" 2>/dev/null || true
    else
      log "centaur: could not materialize chart @ $last — rolling back with current chart"
      rm -rf "$rbroot"; rbroot=""
    fi
  else
    log "centaur: commit $last not in checkout — rolling back with current chart"
  fi
  if [ -n "$rbroot" ]; then
    _helm "$last" "$rbroot" \
      || { log "centaur: rollback with last-good chart failed — retrying with current chart"; _helm "$last" || true; }
  else
    _helm "$last" || true
  fi
  [ -n "$rbroot" ] && rm -rf "$rbroot"
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
  # 1. build cache — bound it to BUILD_CACHE_KEEP, drop the rest.
  #    BOTH flags here are load-bearing, and getting either wrong reclaims 0B while
  #    logging success. Measured on the box (Docker 29.1.3) with 62.58GB of cache:
  #      prune --keep-storage=20g        -> 0B      (deprecated alias: a silent NO-OP.
  #                                                  It warns "changed to reserved-space"
  #                                                  and then does nothing.)
  #      prune --reserved-space=20g      -> 0B      (without -a only DANGLING is eligible)
  #      prune -a                        -> 62.58GB (works, but drops the whole cache)
  #      prune -a --max-used-space=20g   -> bounds to 20g, keeps in-use   <- what we want
  #    This shipped as form 1, so the cache grew unbounded to 62GB and filled the disk
  #    to 91%; kubelet image GC then failed every 5 min ("freed 0 bytes") and pods were
  #    evicted for ephemeral-storage. Do not "simplify" this back to --keep-storage.
  #    Log the reclaimed total: piping to /dev/null is what kept the no-op invisible.
  local reclaimed
  reclaimed="$(sudo docker builder prune -f -a --max-used-space="$BUILD_CACHE_KEEP" 2>/dev/null | tail -1)" \
    || log "prune: warn: builder prune failed"
  log "prune: build cache reclaimed ${reclaimed:-unknown}"
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

# Surface-only prep. A centaur-only deploy must not render the LiveKit config,
# pg_dump the surface DB, or (below) bounce LiveKit — the config bounce would
# force-recreate LiveKit and drop live calls during a deploy unrelated to surface.
case "$TARGET" in
  surface|all) prepare_surface_runtime; backup_db ;;
esac
case "$TARGET" in
  surface) deploy_surface ;;
  centaur) deploy_centaur ;;
  all)     deploy_surface; deploy_centaur ;;
  *) die "unknown target '$TARGET' (surface|centaur|all)" ;;
esac
case "$TARGET" in
  surface|all) refresh_livekit_runtime ;;
esac
# Advance only the baseline(s) for the side(s) actually deployed this run.
case "$TARGET" in
  surface|all) echo "$SHA" > "$STATE/last-deployed-sha-surface" ;;
esac
case "$TARGET" in
  centaur|all) echo "$SHA" > "$STATE/last-deployed-sha-centaur" ;;
esac
# Keep the legacy combined file current when both sides advanced (external readers).
[ "$TARGET" = all ] && echo "$SHA" > "$STATE/last-deployed-sha"
prune_images
log "redeploy DONE ($TARGET) @ $SHA"
