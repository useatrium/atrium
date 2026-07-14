#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEFAULT_REGION="${ATRIUM_PREVIEW_REGION:-iad}"
DEFAULT_TTL_HOURS="${ATRIUM_PREVIEW_TTL_HOURS:-24}"

usage() {
  cat <<'USAGE'
previewctl.sh - local operator helper for Atrium Fly previews

Usage:
  previewctl.sh doctor
  previewctl.sh names [commit-sha]
  previewctl.sh plan [branch-or-ref]
  previewctl.sh image-ref <fly-app> [branch-or-ref]
  previewctl.sh render-config <fly-app> <image-ref>

This is the first spike helper. It does not yet create Fly apps. The launcher
service will eventually own create/status/destroy and reuse this naming/config
contract.
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
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

cmd_doctor() {
  require_cmd git
  require_cmd flyctl
  echo "repo root:      $ROOT"
  echo "origin:         $(repo_remote)"
  echo "flyctl:         $(flyctl version 2>/dev/null | head -1)"
  echo "region:         $DEFAULT_REGION"
  echo "ttl hours:      $DEFAULT_TTL_HOURS"
  if flyctl auth whoami >/dev/null 2>&1; then
    echo "fly auth:       ok ($(flyctl auth whoami 2>/dev/null | head -1))"
  else
    echo "fly auth:       not logged in"
  fi
}

cmd_names() {
  local sha
  local id app image
  sha="$(commit_for_ref "${1:-HEAD}")"
  id="$(preview_id_for_commit "$sha")"
  app="$(fly_app_for_preview "$id")"
  image="$(surface_image_ref "$app" "$sha")"
  cat <<EOF
commit_sha=$sha
preview_id=$id
fly_app=$app
surface_image=$image
s3_prefix=previews/$id/
EOF
}

cmd_plan() {
  local ref="${1:-HEAD}"
  local sha id app expires
  sha="$(commit_for_ref "$ref")"
  id="$(preview_id_for_commit "$sha")"
  app="$(fly_app_for_preview "$id")"
  expires="$(date -u -v +"${DEFAULT_TTL_HOURS}"H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d "+${DEFAULT_TTL_HOURS} hours" '+%Y-%m-%dT%H:%M:%SZ')"
  cat <<EOF
Preview plan
  repo:       $(repo_remote)
  ref:        $ref
  commit:     $sha
  id:         $id
  fly app:    $app
  image:      $(surface_image_ref "$app" "$sha")
  region:     $DEFAULT_REGION
  expires:    $expires

Next implementation steps:
  1. Create Fly app $app in $DEFAULT_REGION.
  2. Build/push Surface image $(surface_image_ref "$app" "$sha").
  3. Provision isolated Postgres and object storage config.
  4. Start Surface, then add Centaur with warm pool disabled.
  5. Poll health and return https://$app.fly.dev.
EOF
}

cmd_image_ref() {
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
  local app="${1:-}"
  local image="${2:-}"
  if [ -z "$app" ] || [ -z "$image" ]; then
    echo "usage: previewctl.sh render-config <fly-app> <image-ref>" >&2
    exit 2
  fi
  render_preview_app_config "$app" "$image"
}

case "${1:-}" in
  doctor)
    cmd_doctor
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
  -h|--help|help|'')
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
