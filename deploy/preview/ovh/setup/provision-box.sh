#!/usr/bin/env bash
set -euo pipefail

K3D_VERSION="v5.7.4"
# previewctl shells out to helm and kubectl; centaur image builds shell out to
# just. None ship with Ubuntu (except just), so pin them here.
HELM_VERSION="v3.16.2"
KUBECTL_VERSION="v1.30.4"
K3S_RELEASE_VERSION="v1.30.4+k3s1"
K3S_IMAGE_VERSION="v1.30.4-k3s1"
REGISTRY_NAME="atrium-preview-registry"
REGISTRY_PORT="5000"
CADDY_CONTAINER="atrium-preview-caddy"
CADDY_IMAGE="atrium-preview-caddy:2-cloudflare"
SERVICE_USER="${ATRIUM_PREVIEW_SERVICE_USER:-atrium-preview}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../../.." && pwd)"
# The launcher runs as $SERVICE_USER and must both read and `git fetch` into its
# checkout. An operator's clone under /home is unreachable to it (home is mode
# 0750 and the unit sets ProtectHome), so the service gets its own checkout at a
# system path. Never point the unit at $REPO_ROOT.
SERVICE_REPO="${ATRIUM_PREVIEW_REPO:-/opt/atrium}"
# The launcher unit runs with ProtectHome=read-only, so the docker CLI cannot
# write buildx state into the service user's home. Give it a writable config dir
# under /var/lib (which is in the unit's ReadWritePaths) and build the cache
# builder there, so the service actually uses the warm builder.
SERVICE_DOCKER_CONFIG="/var/lib/atrium-preview/.docker"
STATE_DIR="/var/lib/atrium-preview/state"
CACHE_ROOT="/var/cache/atrium-preview"
CONFIG_DIR="/etc/atrium-preview"
CADDY_CONFIG_DIR="$CONFIG_DIR/caddy"
CADDY_CONF_DIR="$CADDY_CONFIG_DIR/conf.d"
LAUNCHER_ENV="$CONFIG_DIR/launcher.env"
CADDY_ENV="$CONFIG_DIR/caddy.env"

log() {
  printf '[provision] %s\n' "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# Docker group membership only takes effect in a new login session, so on a
# freshly provisioned box the invoking user cannot reach the socket during this
# very run. Transparently fall back to sudo for the duration of provisioning.
# shellcheck disable=SC2032,SC2033
# `sudo docker` is deliberate: sudo does not inherit shell functions, so it
# execs the real docker binary rather than recursing into this wrapper.
docker() {
  if [[ "${DOCKER_NEEDS_SUDO:-0}" == "1" ]]; then
    sudo docker "$@"
  else
    command docker "$@"
  fi
}

# Run docker as the service user with the service's DOCKER_CONFIG, so buildx
# state lands where the launcher will actually look for it.
svc_docker() {
  sudo -u "$SERVICE_USER" env "DOCKER_CONFIG=$SERVICE_DOCKER_CONFIG" docker "$@"
}

install_docker() {
  # Ubuntu ships the buildx and compose plugins as separate packages. Both are
  # required: previewctl drives `docker compose` for every preview, and the warm
  # cache builder needs `docker buildx`. Mirrors the AWS appliance bootstrap.
  local -a missing=()
  # `type -P` searches PATH only. need_cmd/`command -v` would match the docker()
  # wrapper defined above and wrongly report docker as already installed.
  type -P docker >/dev/null 2>&1 || missing+=(docker.io)
  local package
  for package in docker-buildx docker-compose-v2; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'ok installed'; then
      missing+=("$package")
    fi
  done
  if ((${#missing[@]})); then
    log "installing: ${missing[*]}"
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  else
    log "docker + buildx + compose already installed ($(command docker --version 2>/dev/null))"
  fi
  sudo systemctl enable --now docker
  # The invoking admin needs group membership to run docker without sudo. This
  # only takes effect in new sessions, so we do not rely on it during this run.
  if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    sudo usermod -aG docker "$USER"
    log "added $USER to docker group (re-login required for it to take effect)"
  fi
  if ! command docker info >/dev/null 2>&1; then
    DOCKER_NEEDS_SUDO=1
    log "docker socket not reachable as $USER this session; using sudo for provisioning"
  fi
}

install_packages() {
  local -a missing=()
  local package
  for package in ca-certificates curl cron sqlite3 just; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'ok installed'; then
      missing+=("$package")
    fi
  done
  if ((${#missing[@]})); then
    log "installing packages: ${missing[*]}"
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  else
    log "required apt packages already installed"
  fi
}

install_k3d() {
  if need_cmd k3d && [[ "$(k3d version 2>/dev/null | awk '/k3d version/ {print $3; exit}')" == "$K3D_VERSION" ]]; then
    log "k3d $K3D_VERSION already installed"
    return
  fi

  local tmp
  tmp="$(mktemp)"
  curl -fsSL "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-amd64" -o "$tmp"
  chmod 0755 "$tmp"
  sudo install -m 0755 "$tmp" /usr/local/bin/k3d
  rm -f "$tmp"
  log "installed k3d $K3D_VERSION"
}

install_k3s_cli() {
  if need_cmd k3s && k3s --version 2>/dev/null | head -n 1 | grep -Fq "$K3S_RELEASE_VERSION"; then
    log "k3s CLI $K3S_RELEASE_VERSION already installed"
    return
  fi

  local tmp release_version
  tmp="$(mktemp)"
  release_version="${K3S_RELEASE_VERSION/+/%2B}"
  curl -fsSL "https://github.com/k3s-io/k3s/releases/download/${release_version}/k3s" -o "$tmp"
  chmod 0755 "$tmp"
  sudo install -m 0755 "$tmp" /usr/local/bin/k3s
  rm -f "$tmp"
  log "installed host k3s CLI $K3S_RELEASE_VERSION for validate-overlay.sh"
}

install_helm() {
  if need_cmd helm && helm version --short 2>/dev/null | grep -Fq "$HELM_VERSION"; then
    log "helm $HELM_VERSION already installed"
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" | tar -xz -C "$tmp"
  sudo install -m 0755 "$tmp/linux-amd64/helm" /usr/local/bin/helm
  rm -rf "$tmp"
  log "installed helm $HELM_VERSION"
}

install_kubectl() {
  if need_cmd kubectl && kubectl version --client 2>/dev/null | grep -Fq "$KUBECTL_VERSION"; then
    log "kubectl $KUBECTL_VERSION already installed"
    return
  fi
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o "$tmp"
  sudo install -m 0755 "$tmp" /usr/local/bin/kubectl
  rm -f "$tmp"
  log "installed kubectl $KUBECTL_VERSION"
}

ensure_service_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    sudo useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    log "created service user $SERVICE_USER"
  fi
  if ! id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
    sudo usermod -aG docker "$SERVICE_USER"
    log "added $SERVICE_USER to docker group"
  fi
}

ensure_directories() {
  sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 /var/lib/atrium-preview
  sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR"
  sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 \
    "$CACHE_ROOT" \
    "$CACHE_ROOT/pnpm/store" \
    "$CACHE_ROOT/cargo/registry" \
    "$CACHE_ROOT/cargo/git" \
    "$CACHE_ROOT/cargo/target" \
    "$CACHE_ROOT/buildkit" \
    "$SERVICE_DOCKER_CONFIG"
  sudo install -d -m 0755 "$CONFIG_DIR" "$CADDY_CONFIG_DIR"
  sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$CADDY_CONF_DIR"
}

ensure_registry() {
  if ! docker image inspect registry:2 >/dev/null 2>&1; then
    docker pull registry:2
  fi
  if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
    if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME")" != true ]]; then
      docker start "$REGISTRY_NAME" >/dev/null
    fi
    log "local registry container already exists"
    return
  fi
  docker volume create atrium-preview-registry >/dev/null
  docker run -d \
    --name "$REGISTRY_NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    -v atrium-preview-registry:/var/lib/registry \
    registry:2 >/dev/null
  log "started local registry on 127.0.0.1:$REGISTRY_PORT"
}

ensure_caddy_image() {
  if docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
    log "Caddy image with Cloudflare DNS module already exists"
    return
  fi
  log "building Caddy image with Cloudflare DNS module"
  docker build -t "$CADDY_IMAGE" - <<'DOCKERFILE'
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
DOCKERFILE
}

write_secret_envs() {
  if [[ ! -e "$CADDY_ENV" ]]; then
    sudo install -m 0600 /dev/null "$CADDY_ENV"
    printf 'CF_API_TOKEN=%s\nACME_EMAIL=%s\n' \
      "${CF_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" \
      "${ACME_EMAIL:-}" | sudo tee "$CADDY_ENV" >/dev/null
  else
    log "preserving existing $CADDY_ENV"
  fi

  if [[ ! -e "$LAUNCHER_ENV" ]]; then
    sudo install -m 0600 /dev/null "$LAUNCHER_ENV"
    printf 'ATRIUM_PREVIEW_LAUNCHER_TOKEN=%s\nMAX_CONCURRENT_PREVIEWS=%s\nATRIUM_PREVIEW_STATE_DIR=%s\nPREVIEW_LAUNCHER_DB=%s/launcher.sqlite3\nPREVIEW_LAUNCHER_HOST=127.0.0.1\nPREVIEW_LAUNCHER_PORT=8787\n' \
      "${ATRIUM_PREVIEW_LAUNCHER_TOKEN:-}" \
      "${MAX_CONCURRENT_PREVIEWS:-3}" \
      "$STATE_DIR" \
      "$STATE_DIR" | sudo tee "$LAUNCHER_ENV" >/dev/null
  else
    log "preserving existing $LAUNCHER_ENV"
  fi
}

install_caddy() {
  sudo install -m 0644 "$SCRIPT_DIR/Caddyfile.tmpl" "$CADDY_CONFIG_DIR/Caddyfile"
  docker volume create atrium-preview-caddy-data >/dev/null
  docker volume create atrium-preview-caddy-config >/dev/null

  local unit_tmp
  unit_tmp="$(mktemp)"
  cat >"$unit_tmp" <<EOF
[Unit]
Description=Atrium preview shared Caddy proxy
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=$CADDY_ENV
ExecStartPre=-/usr/bin/docker rm -f $CADDY_CONTAINER
ExecStart=/usr/bin/docker run --name $CADDY_CONTAINER --network host --env-file $CADDY_ENV --volume $CADDY_CONFIG_DIR/Caddyfile:/etc/caddy/Caddyfile:ro --volume $CADDY_CONF_DIR:/etc/caddy/conf.d:ro --volume atrium-preview-caddy-data:/data --volume atrium-preview-caddy-config:/config $CADDY_IMAGE caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/bin/docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
ExecStop=/usr/bin/docker stop $CADDY_CONTAINER
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF
  sudo install -m 0644 "$unit_tmp" /etc/systemd/system/atrium-preview-caddy.service
  rm -f "$unit_tmp"
}

ensure_service_repo() {
  local origin_url head_sha current
  origin_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null \
    || echo 'https://github.com/useatrium/atrium.git')"
  if [[ ! -d "$SERVICE_REPO/.git" ]]; then
    sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$SERVICE_REPO"
    sudo -u "$SERVICE_USER" git clone --quiet "$origin_url" "$SERVICE_REPO"
    log "cloned service repo to $SERVICE_REPO"
  fi
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_REPO"
  sudo -u "$SERVICE_USER" git -C "$SERVICE_REPO" fetch --quiet --all --prune || true
  # Track whatever the operator provisioned from, so the service runs the same
  # code. Only works for commits that exist on the remote.
  head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$head_sha" ]] && sudo -u "$SERVICE_USER" git -C "$SERVICE_REPO" cat-file -e "${head_sha}^{commit}" 2>/dev/null; then
    sudo -u "$SERVICE_USER" git -C "$SERVICE_REPO" checkout --quiet --detach "$head_sha"
  else
    log "warning: $head_sha not on the remote; service repo left at its current HEAD"
  fi
  current="$(sudo -u "$SERVICE_USER" git -C "$SERVICE_REPO" rev-parse --short HEAD)"
  log "service repo $SERVICE_REPO at $current"
}

install_launcher_and_janitor() {
  local unit_tmp cron_tmp
  unit_tmp="$(mktemp)"
  cron_tmp="$(mktemp)"
  sed \
    -e "s|__ATRIUM_REPO_ROOT__|$SERVICE_REPO|g" \
    -e "s|__ATRIUM_SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__ATRIUM_LAUNCHER_ENV__|$LAUNCHER_ENV|g" \
    "$SCRIPT_DIR/launcher.service" >"$unit_tmp"
  sudo install -m 0644 "$unit_tmp" /etc/systemd/system/atrium-preview-launcher.service
  rm -f "$unit_tmp"

  sed \
    -e "s|__ATRIUM_REPO_ROOT__|$SERVICE_REPO|g" \
    -e "s|__ATRIUM_SERVICE_USER__|$SERVICE_USER|g" \
    "$SCRIPT_DIR/janitor.cron" >"$cron_tmp"
  sudo install -m 0644 "$cron_tmp" /etc/cron.d/atrium-preview-janitor
  rm -f "$cron_tmp"
  sudo systemctl enable --now cron >/dev/null
}

warm_images_and_buildkit() {
  local -a images=(
    "postgres:16"
    "minio/minio:RELEASE.2025-09-07T16-13-09Z"
    "caddy:2-alpine"
    "rancher/k3s:$K3S_IMAGE_VERSION"
    "moby/buildkit:buildx-stable-1"
    "ubuntu:22.04"
  )
  local image
  for image in "${images[@]}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      log "warm image already present: $image"
    else
      docker pull "$image"
    fi
  done

  if svc_docker buildx inspect atrium-preview-builder >/dev/null 2>&1; then
    log "buildx cache builder already exists"
  else
    svc_docker buildx create \
      --name atrium-preview-builder \
      --driver docker-container \
      --driver-opt "network=host" \
      --use >/dev/null
    log "created buildx cache builder for $SERVICE_USER"
  fi
  svc_docker buildx inspect --bootstrap atrium-preview-builder >/dev/null
}

start_configured_services() {
  sudo systemctl daemon-reload
  sudo systemctl enable atrium-preview-caddy.service atrium-preview-launcher.service >/dev/null

  if sudo grep -Eq '^CF_API_TOKEN=.+$' "$CADDY_ENV" && sudo grep -Eq '^ACME_EMAIL=.+$' "$CADDY_ENV"; then
    sudo systemctl restart atrium-preview-caddy.service
  else
    log "Caddy installed but not started: set CF_API_TOKEN and ACME_EMAIL in $CADDY_ENV"
  fi

  if sudo grep -Eq '^ATRIUM_PREVIEW_LAUNCHER_TOKEN=.+$' "$LAUNCHER_ENV"; then
    sudo systemctl restart atrium-preview-launcher.service
  else
    log "launcher installed but not started: set ATRIUM_PREVIEW_LAUNCHER_TOKEN in $LAUNCHER_ENV"
  fi
}

print_checklist() {
  cat <<EOF

Provisioning complete. Human/secret checklist:
  [ ] Put a scoped Cloudflare token in $CADDY_ENV as CF_API_TOKEN.
      It needs Zone:DNS:Edit for useatrium.com; also set ACME_EMAIL.
  [ ] Put a strong launcher bearer token in $LAUNCHER_ENV as
      ATRIUM_PREVIEW_LAUNCHER_TOKEN (and review MAX_CONCURRENT_PREVIEWS).
  [ ] Run $SCRIPT_DIR/validate-overlay.sh; require POC_RESULT=CONFIRMED.
  [ ] Point *.preview.useatrium.com at this box (DNS-only A/AAAA record).
  [ ] Create the cloudflared tunnel for preview-launcher.useatrium.com; see
      $SCRIPT_DIR/cloudflared.md. Do not enable Cloudflare Access on that host.
  [ ] After adding secrets, run:
      sudo systemctl restart atrium-preview-caddy atrium-preview-launcher
EOF
}

main() {
  if [[ "$(uname -m)" != "x86_64" ]]; then
    printf 'This provisioner expects x86_64; found %s\n' "$(uname -m)" >&2
    exit 1
  fi
  install_docker
  install_packages
  install_k3d
  install_k3s_cli
  install_helm
  install_kubectl
  ensure_service_user
  ensure_directories
  ensure_service_repo
  ensure_registry
  ensure_caddy_image
  write_secret_envs
  install_caddy
  install_launcher_and_janitor
  warm_images_and_buildkit
  start_configured_services
  print_checklist
}

main "$@"
