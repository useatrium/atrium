#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/deploy/preview/fly/.env"
DEFAULT_REGION="${ATRIUM_PREVIEW_REGION:-iad}"
DEFAULT_TTL_HOURS="${ATRIUM_PREVIEW_TTL_HOURS:-24}"
DEFAULT_ORG="${FLY_ORG:-personal}"
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
  local attempts="${2:-60}"
  local delay="${3:-5}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS "$url/healthz" >/dev/null 2>&1; then
      echo "health:         ok ($url/healthz)"
      return 0
    fi
    sleep "$delay"
  done
  echo "health:         failed after $((attempts * delay))s ($url/healthz)" >&2
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
    CENTAUR_BASE_URL="" \
    CENTAUR_API_KEY=""

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
