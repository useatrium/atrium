#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/deploy/preview/fly/.env"
DEFAULT_REGION="${ATRIUM_PREVIEW_REGION:-iad}"
DEFAULT_TTL_HOURS="${ATRIUM_PREVIEW_TTL_HOURS:-24}"
DEFAULT_ORG="${FLY_ORG:-personal}"
DEFAULT_IRON_CONTROL_APP="${ATRIUM_PREVIEW_IRON_CONTROL_APP:-atrium-preview-iron-control}"
DEFAULT_IRON_CONTROL_PG_APP="${ATRIUM_PREVIEW_IRON_CONTROL_PG_APP:-atrium-preview-iron-control-pg}"
PREVIEW_TMP=""
PREVIEW_WORKTREE=""

usage() {
  cat <<'USAGE'
previewctl.sh - local operator helper for Atrium Fly previews

Usage:
  previewctl.sh doctor
  previewctl.sh s3-smoke
  previewctl.sh names [branch-or-ref]
  previewctl.sh plan [branch-or-ref]
  previewctl.sh image-ref <fly-app> [branch-or-ref]
  previewctl.sh render-config <fly-app> <image-ref>
  previewctl.sh create-iron-control
  previewctl.sh wire-surface-iron-control <surface-fly-app> [namespace]
  previewctl.sh wire-surface-centaur <surface-fly-app> <centaur-base-url> [centaur-api-key]
  previewctl.sh set-surface-capture-key <surface-fly-app> [artifact-capture-api-key]
  previewctl.sh create-surface [branch-or-ref]
  previewctl.sh destroy <fly-app>

This is the first spike helper. create-surface deploys an arbitrary Atrium ref
from a temporary git worktree, so the target branch does not need to contain
this preview tooling.
USAGE
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
  DEFAULT_REGION="${ATRIUM_PREVIEW_REGION:-${DEFAULT_REGION:-iad}}"
  DEFAULT_TTL_HOURS="${ATRIUM_PREVIEW_TTL_HOURS:-${DEFAULT_TTL_HOURS:-24}}"
  DEFAULT_ORG="${FLY_ORG:-${DEFAULT_ORG:-personal}}"
  DEFAULT_IRON_CONTROL_APP="${ATRIUM_PREVIEW_IRON_CONTROL_APP:-${DEFAULT_IRON_CONTROL_APP:-atrium-preview-iron-control}}"
  DEFAULT_IRON_CONTROL_PG_APP="${ATRIUM_PREVIEW_IRON_CONTROL_PG_APP:-${DEFAULT_IRON_CONTROL_PG_APP:-atrium-preview-iron-control-pg}}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_env() {
  local missing=()
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      missing+=("$name")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'missing required env: %s\n' "${missing[*]}" >&2
    exit 2
  fi
}

repo_remote() {
  git -C "$ROOT" remote get-url origin
}

commit_for_ref() {
  local ref="${1:-HEAD}"
  git -C "$ROOT" rev-parse "$ref^{commit}"
}

short_sha() {
  printf '%s' "$1" | cut -c1-12
}

nonce() {
  LC_ALL=C od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-4
}

preview_id_for_commit() {
  local sha="$1"
  local n="${2:-}"
  [ -n "$n" ] || n="$(nonce)"
  printf 'prev-%s-%s' "$(short_sha "$sha")" "$n"
}

fly_app_for_preview() {
  local preview_id="$1"
  printf 'atrium-%s' "$preview_id"
}

pg_app_for_preview() {
  local preview_id="$1"
  printf 'atrium-pg-%s' "${preview_id#prev-}"
}

surface_image_ref() {
  local app="$1"
  local sha="$2"
  printf 'registry.fly.io/%s:%s' "$app" "$sha"
}

render_preview_app_config() {
  local app="$1"
  local image="$2"
  local template="$ROOT/deploy/preview/fly/templates/preview-app.fly.toml.tmpl"

  sed \
    -e "s|{{FLY_APP_NAME}}|$app|g" \
    -e "s|{{FLY_REGION}}|$DEFAULT_REGION|g" \
    -e "s|{{SURFACE_IMAGE}}|$image|g" \
    "$template"
}

render_surface_source_config() {
  local app="$1"
  local template="$ROOT/deploy/preview/fly/templates/surface-source.fly.toml.tmpl"

  sed \
    -e "s|{{FLY_APP_NAME}}|$app|g" \
    -e "s|{{FLY_REGION}}|$DEFAULT_REGION|g" \
    "$template"
}

random_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

random_iron_api_key() {
  printf 'iak_%s' "$(random_hex 32)"
}

fly_app_exists() {
  local app="$1"
  flyctl status --app "$app" >/dev/null 2>&1
}

append_env_value() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  {
    printf '\n'
    printf '%s=%s\n' "$key" "$value"
  } >>"$ENV_FILE"
}

make_worktree() {
  local ref="$1"
  local dir="$2"
  git -C "$ROOT" worktree add --detach "$dir" "$ref" >/dev/null
}

install_preview_build_files() {
  local dir="$1"
  mkdir -p "$dir/deploy/preview/fly/.generated"
  cp "$ROOT/deploy/preview/fly/templates/preview-surface-web.Dockerfile" \
    "$dir/deploy/preview/fly/.generated/Dockerfile"
  cp "$ROOT/deploy/preview/fly/templates/preview.Caddyfile" \
    "$dir/deploy/preview/fly/.generated/Caddyfile"
}

remove_worktree() {
  local dir="$1"
  git -C "$ROOT" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
}

cleanup_preview_worktree() {
  if [ -n "${PREVIEW_WORKTREE:-}" ]; then
    remove_worktree "$PREVIEW_WORKTREE"
  fi
  if [ -n "${PREVIEW_TMP:-}" ]; then
    rm -rf "$PREVIEW_TMP"
  fi
}

wait_for_health() {
  local url="$1"
  wait_for_path "$url" "/healthz" "${2:-60}" "${3:-5}"
}

wait_for_path() {
  local url="$1"
  local path="$2"
  local attempts="${3:-60}"
  local delay="${4:-5}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS "$url$path" >/dev/null 2>&1; then
      echo "health:         ok ($url$path)"
      return 0
    fi
    sleep "$delay"
  done
  echo "health:         failed after $((attempts * delay))s ($url$path)" >&2
  return 1
}

cmd_doctor() {
  load_env
  require_cmd git
  require_cmd flyctl
  echo "repo root:      $ROOT"
  echo "origin:         $(repo_remote)"
  echo "flyctl:         $(flyctl version 2>/dev/null | head -1)"
  echo "org:            $DEFAULT_ORG"
  echo "region:         $DEFAULT_REGION"
  echo "ttl hours:      $DEFAULT_TTL_HOURS"
  echo "env file:       $([ -f "$ENV_FILE" ] && echo present || echo missing)"
  echo "s3 bucket:      ${S3_BUCKET:-unset}"
  echo "s3 endpoint:    ${S3_ENDPOINT:-unset}"
  echo "iron app:       $DEFAULT_IRON_CONTROL_APP"
  echo "iron-control:   $([ -n "${IRON_CONTROL_BASE_URL:-}" ] && [ -n "${IRON_CONTROL_API_KEY:-}" ] && echo configured || echo unset)"
  echo "centaur:        $([ -n "${CENTAUR_BASE_URL:-}" ] && [ -n "${CENTAUR_API_KEY:-}" ] && echo configured || echo unset)"
  if flyctl auth whoami >/dev/null 2>&1; then
    echo "fly auth:       ok ($(flyctl auth whoami 2>/dev/null | head -1))"
  else
    echo "fly auth:       not logged in"
  fi
}

cmd_s3_smoke() {
  load_env
  require_cmd python3
  require_env S3_BUCKET S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY
  python3 "$ROOT/deploy/preview/fly/s3_smoke.py" \
    --bucket "$S3_BUCKET" \
    --endpoint "$S3_ENDPOINT" \
    --access-key "$S3_ACCESS_KEY" \
    --secret-key "$S3_SECRET_KEY" \
    --signing-region us-east-1 \
    --prefix previews/smoke
}

cmd_names() {
  load_env
  local sha id app pg image
  sha="$(commit_for_ref "${1:-HEAD}")"
  id="$(preview_id_for_commit "$sha")"
  app="$(fly_app_for_preview "$id")"
  pg="$(pg_app_for_preview "$id")"
  image="$(surface_image_ref "$app" "$sha")"
  cat <<EOF
commit_sha=$sha
preview_id=$id
fly_app=$app
postgres_app=$pg
surface_image=$image
s3_bucket=${S3_BUCKET:-}
EOF
}

cmd_plan() {
  load_env
  local ref="${1:-HEAD}"
  local sha id app pg expires
  sha="$(commit_for_ref "$ref")"
  id="$(preview_id_for_commit "$sha")"
  app="$(fly_app_for_preview "$id")"
  pg="$(pg_app_for_preview "$id")"
  expires="$(date -u -v +"${DEFAULT_TTL_HOURS}"H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d "+${DEFAULT_TTL_HOURS} hours" '+%Y-%m-%dT%H:%M:%SZ')"
  cat <<EOF
Preview plan
  repo:       $(repo_remote)
  ref:        $ref
  commit:     $sha
  id:         $id
  fly app:    $app
  pg app:     $pg
  image:      $(surface_image_ref "$app" "$sha")
  org:        $DEFAULT_ORG
  region:     $DEFAULT_REGION
  s3 bucket:  ${S3_BUCKET:-unset}
  expires:    $expires

Next implementation steps:
  1. Create Fly app $app in $DEFAULT_REGION.
  2. Build/push Surface image $(surface_image_ref "$app" "$sha").
  3. Provision isolated Postgres app $pg.
  4. Inject generated secrets plus existing S3_* preview storage config.
  5. Start Surface, then add Centaur with warm pool disabled.
  6. Poll health and return https://$app.fly.dev.
EOF
}

cmd_image_ref() {
  load_env
  local app="${1:-}"
  local ref="${2:-HEAD}"
  if [ -z "$app" ]; then
    echo "usage: previewctl.sh image-ref <fly-app> [branch-or-ref]" >&2
    exit 2
  fi
  surface_image_ref "$app" "$(commit_for_ref "$ref")"
  printf '\n'
}

cmd_render_config() {
  load_env
  local app="${1:-}"
  local image="${2:-}"
  if [ -z "$app" ] || [ -z "$image" ]; then
    echo "usage: previewctl.sh render-config <fly-app> <image-ref>" >&2
    exit 2
  fi
  render_preview_app_config "$app" "$image"
}

cmd_create_iron_control() {
  load_env
  require_cmd flyctl
  require_cmd openssl
  require_cmd curl

  local app="$DEFAULT_IRON_CONTROL_APP"
  local pg="$DEFAULT_IRON_CONTROL_PG_APP"
  local url="https://$app.fly.dev"
  local had_iron_env=0
  if [ -n "${IRON_CONTROL_BASE_URL:-}" ] && [ -n "${IRON_CONTROL_API_KEY:-}" ]; then
    had_iron_env=1
  fi
  local api_key="${IRON_CONTROL_API_KEY:-$(random_iron_api_key)}"
  local tmp config secret_names
  tmp="$(mktemp -d)"
  config="$tmp/fly.toml"
  trap 'rm -rf "$tmp"' EXIT

  cat >"$config" <<EOF
app = "$app"
primary_region = "$DEFAULT_REGION"

[processes]
  app = "bash -lc './bin/rails db:prepare && exec ./bin/rails server -b 0.0.0.0'"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [[http_service.checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "30s"
    method = "GET"
    path = "/up"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "1gb"
EOF

  cat <<EOF
Creating shared preview iron-control
  fly app:    $app
  pg app:     $pg
  url:        $url
EOF

  if fly_app_exists "$app"; then
    echo "fly app:        exists"
  else
    flyctl apps create "$app" --org "$DEFAULT_ORG" --yes
    flyctl ips allocate-v6 --app "$app" --region "$DEFAULT_REGION" || true
    flyctl ips allocate-v4 --app "$app" --region "$DEFAULT_REGION" --shared --yes || true
  fi

  if fly_app_exists "$pg"; then
    echo "postgres app:   exists"
  else
    flyctl postgres create \
      --name "$pg" \
      --org "$DEFAULT_ORG" \
      --region "$DEFAULT_REGION" \
      --initial-cluster-size 1 \
      --vm-cpu-kind shared \
      --vm-cpus 1 \
      --vm-memory 512 \
      --volume-size 1
  fi

  if flyctl secrets list --app "$app" 2>/dev/null | awk '{print $1}' | grep -qx CENTAUR_CONSOLE_DATABASE_URL; then
    echo "database:       already attached"
  else
    flyctl postgres attach "$pg" \
      --app "$app" \
      --database-name iron_control \
      --database-user iron_control \
      --variable-name CENTAUR_CONSOLE_DATABASE_URL \
      --yes
  fi

  secret_names="$(flyctl secrets list --app "$app" 2>/dev/null | awk '{print $1}')"
  if printf '%s\n' "$secret_names" | grep -qx CENTAUR_CONSOLE_INITIAL_API_KEY; then
    if [ "$had_iron_env" -ne 1 ]; then
      echo "iron-control already has an API key, but IRON_CONTROL_API_KEY is missing from $ENV_FILE" >&2
      echo "Fly secrets cannot be read back; restore the local .env value or create a new control-plane app." >&2
      exit 2
    fi
    echo "bootstrap:      existing secrets kept"
    flyctl secrets set --app "$app" --stage \
      CENTAUR_CONSOLE_PUBLIC_URL="$url" \
      RAILS_LOG_TO_STDOUT=1 \
      RAILS_MAX_THREADS=3 \
      PORT=3000
  else
    flyctl secrets set --app "$app" --stage \
      SECRET_KEY_BASE="$(random_hex 64)" \
      CENTAUR_CONSOLE_AR_ENCRYPTION_PRIMARY_KEY="$(random_hex 32)" \
      CENTAUR_CONSOLE_AR_ENCRYPTION_DETERMINISTIC_KEY="$(random_hex 32)" \
      CENTAUR_CONSOLE_AR_ENCRYPTION_KEY_DERIVATION_SALT="$(random_hex 32)" \
      CENTAUR_CONSOLE_INITIAL_USER_EMAIL="${CENTAUR_CONSOLE_INITIAL_USER_EMAIL:-preview-operator@example.invalid}" \
      CENTAUR_CONSOLE_INITIAL_USER_PASSWORD="${CENTAUR_CONSOLE_INITIAL_USER_PASSWORD:-$(random_hex 24)}" \
      CENTAUR_CONSOLE_INITIAL_API_KEY="$api_key" \
      CENTAUR_CONSOLE_PUBLIC_URL="$url" \
      RAILS_LOG_TO_STDOUT=1 \
      RAILS_MAX_THREADS=3 \
      PORT=3000
  fi

  flyctl deploy "$ROOT/centaur/services/console" \
    --app "$app" \
    --config "$config" \
    --dockerfile "$ROOT/centaur/services/console/Dockerfile" \
    --remote-only \
    --ha=false \
    --yes \
    --wait-timeout 15m

  wait_for_path "$url" "/up" 80 5

  if [ "$had_iron_env" -ne 1 ]; then
    append_env_value ATRIUM_PREVIEW_IRON_CONTROL_APP "$app"
    append_env_value ATRIUM_PREVIEW_IRON_CONTROL_PG_APP "$pg"
    append_env_value IRON_CONTROL_BASE_URL "$url"
    append_env_value IRON_CONTROL_API_KEY "$api_key"
    append_env_value IRON_CONTROL_NAMESPACE "${IRON_CONTROL_NAMESPACE:-default}"
  fi

  cat <<EOF
Shared preview iron-control ready
  url:        $url
  app:        $app
  postgres:   $pg

Local gitignored env file:
  deploy/preview/fly/.env
EOF

  trap - EXIT
  rm -rf "$tmp"
}

cmd_wire_surface_iron_control() {
  load_env
  require_cmd flyctl
  local app="${1:-}"
  local namespace="${2:-}"
  if [ -z "$app" ]; then
    echo "usage: previewctl.sh wire-surface-iron-control <surface-fly-app> [namespace]" >&2
    exit 2
  fi
  case "$app" in
    atrium-prev-*) ;;
    *)
      echo "refusing to wire non-preview app: $app" >&2
      exit 2
      ;;
  esac
  require_env IRON_CONTROL_BASE_URL IRON_CONTROL_API_KEY
  if [ -z "$namespace" ]; then
    namespace="prev-${app#atrium-prev-}"
  fi
  flyctl secrets set --app "$app" \
    IRON_CONTROL_BASE_URL="$IRON_CONTROL_BASE_URL" \
    IRON_CONTROL_API_KEY="$IRON_CONTROL_API_KEY" \
    IRON_CONTROL_NAMESPACE="$namespace"
  echo "wired $app to iron-control namespace $namespace"
}

cmd_wire_surface_centaur() {
  load_env
  require_cmd flyctl
  require_cmd curl
  local app="${1:-}"
  local base_url="${2:-${CENTAUR_BASE_URL:-}}"
  local api_key="${3:-${CENTAUR_API_KEY:-}}"
  if [ -z "$app" ] || [ -z "$base_url" ] || [ -z "$api_key" ]; then
    echo "usage: previewctl.sh wire-surface-centaur <surface-fly-app> <centaur-base-url> [centaur-api-key]" >&2
    echo "       CENTAUR_API_KEY may also be provided from deploy/preview/fly/.env" >&2
    exit 2
  fi
  case "$app" in
    atrium-prev-*) ;;
    *)
      echo "refusing to wire non-preview app: $app" >&2
      exit 2
      ;;
  esac
  flyctl secrets set --app "$app" \
    CENTAUR_BASE_URL="$base_url" \
    CENTAUR_API_KEY="$api_key"
  wait_for_health "https://${app}.fly.dev"
  echo "wired $app to Centaur"
}

cmd_set_surface_capture_key() {
  load_env
  require_cmd flyctl
  require_cmd curl
  local app="${1:-}"
  local key="${2:-${ARTIFACT_CAPTURE_API_KEY:-}}"
  if [ -z "$app" ] || [ -z "$key" ]; then
    echo "usage: previewctl.sh set-surface-capture-key <surface-fly-app> [artifact-capture-api-key]" >&2
    echo "       ARTIFACT_CAPTURE_API_KEY may also be provided from the environment" >&2
    exit 2
  fi
  case "$app" in
    atrium-prev-*) ;;
    *)
      echo "refusing to modify non-preview app: $app" >&2
      exit 2
      ;;
  esac
  flyctl secrets set --app "$app" ARTIFACT_CAPTURE_API_KEY="$key"
  wait_for_health "https://${app}.fly.dev"
  echo "set artifact capture key for $app"
}

cmd_create_surface() {
  load_env
  require_cmd git
  require_cmd flyctl
  require_cmd openssl
  require_cmd curl
  require_env S3_BUCKET S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY

  "$0" s3-smoke

  local ref="${1:-HEAD}"
  local sha id app pg image tmp worktree config url
  sha="$(commit_for_ref "$ref")"
  id="$(preview_id_for_commit "$sha")"
  app="$(fly_app_for_preview "$id")"
  pg="$(pg_app_for_preview "$id")"
  image="$(surface_image_ref "$app" "$sha")"
  tmp="$(mktemp -d)"
  worktree="$tmp/repo"
  config="$tmp/fly.toml"
  url="https://$app.fly.dev"
  PREVIEW_TMP="$tmp"
  PREVIEW_WORKTREE="$worktree"

  make_worktree "$sha" "$worktree"
  install_preview_build_files "$worktree"
  render_surface_source_config "$app" >"$config"

  trap cleanup_preview_worktree EXIT

  cat <<EOF
Creating Surface preview
  ref:        $ref
  commit:     $sha
  id:         $id
  fly app:    $app
  pg app:     $pg
  image:      $image
  s3 bucket:  $S3_BUCKET
  url:        $url
EOF

  flyctl apps create "$app" --org "$DEFAULT_ORG" --yes
  flyctl ips allocate-v6 --app "$app" --region "$DEFAULT_REGION" || true
  flyctl ips allocate-v4 --app "$app" --region "$DEFAULT_REGION" --shared --yes || true

  flyctl postgres create \
    --name "$pg" \
    --org "$DEFAULT_ORG" \
    --region "$DEFAULT_REGION" \
    --initial-cluster-size 1 \
    --vm-cpu-kind shared \
    --vm-cpus 1 \
    --vm-memory 512 \
    --volume-size 1

  flyctl postgres attach "$pg" --app "$app" --database-name atrium --database-user atrium --yes

  flyctl secrets set --app "$app" --stage \
    SESSION_SECRET="$(random_hex 32)" \
    APP_SIGNING_SECRET="$(random_hex 32)" \
    PROVIDER_CREDENTIAL_SECRET="$(random_hex 32)" \
    ARTIFACT_CAPTURE_API_KEY="$(random_hex 32)" \
    S3_ENDPOINT="$S3_ENDPOINT" \
    S3_INTERNAL_ENDPOINT="$S3_ENDPOINT" \
    S3_BUCKET="$S3_BUCKET" \
    S3_ACCESS_KEY="$S3_ACCESS_KEY" \
    S3_SECRET_KEY="$S3_SECRET_KEY" \
    APPS_ORIGIN="$url" \
    APPS_HOST=127.0.0.1 \
    APPS_PORT=3002 \
    AUTH_OPEN=1 \
    AUTH_DEV_CODES=1 \
    EMAIL_MODE=log \
    CENTAUR_BASE_URL="${CENTAUR_BASE_URL:-}" \
    CENTAUR_API_KEY="${CENTAUR_API_KEY:-}"

  if [ -n "${IRON_CONTROL_BASE_URL:-}" ] && [ -n "${IRON_CONTROL_API_KEY:-}" ]; then
    flyctl secrets set --app "$app" --stage \
      IRON_CONTROL_BASE_URL="$IRON_CONTROL_BASE_URL" \
      IRON_CONTROL_API_KEY="$IRON_CONTROL_API_KEY" \
      IRON_CONTROL_NAMESPACE="${IRON_CONTROL_NAMESPACE:-default}"
  fi

  flyctl deploy "$worktree" \
    --app "$app" \
    --config "$config" \
    --dockerfile "$worktree/deploy/preview/fly/.generated/Dockerfile" \
    --image-label "$sha" \
    --remote-only \
    --ha=false \
    --yes \
    --wait-timeout 10m

  wait_for_health "$url"

  cat <<EOF
Preview ready
  url:        $url
  commit:     $sha
  app:        $app
  postgres:   $pg

Destroy with:
  deploy/preview/fly/previewctl.sh destroy $app
EOF

  trap - EXIT
  cleanup_preview_worktree
  PREVIEW_TMP=""
  PREVIEW_WORKTREE=""
}

cmd_destroy() {
  load_env
  require_cmd flyctl
  local app="${1:-}"
  if [ -z "$app" ]; then
    echo "usage: previewctl.sh destroy <fly-app>" >&2
    exit 2
  fi
  case "$app" in
    atrium-prev-*) ;;
    *)
      echo "refusing to destroy non-preview app: $app" >&2
      exit 2
      ;;
  esac
  local pg="atrium-pg-${app#atrium-prev-}"
  flyctl apps destroy "$pg" --yes || true
  flyctl apps destroy "$app" --yes || true
}

case "${1:-}" in
  doctor)
    cmd_doctor
    ;;
  s3-smoke)
    cmd_s3_smoke
    ;;
  names)
    shift
    cmd_names "$@"
    ;;
  plan)
    shift
    cmd_plan "$@"
    ;;
  image-ref)
    shift
    cmd_image_ref "$@"
    ;;
  render-config)
    shift
    cmd_render_config "$@"
    ;;
  create-iron-control)
    cmd_create_iron_control
    ;;
  wire-surface-iron-control)
    shift
    cmd_wire_surface_iron_control "$@"
    ;;
  wire-surface-centaur)
    shift
    cmd_wire_surface_centaur "$@"
    ;;
  set-surface-capture-key)
    shift
    cmd_set_surface_capture_key "$@"
    ;;
  create-surface)
    shift
    cmd_create_surface "$@"
    ;;
  destroy)
    shift
    cmd_destroy "$@"
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
