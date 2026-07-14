#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/deploy/preview/fly/.env"

usage() {
  cat <<'USAGE'
deploy-shared-runtime.sh - deploy Centaur for one active Atrium preview Surface

Run this on a Linux VM with Docker, k3s, kubectl, helm, just, and this Atrium
checkout. It deploys a shared preview Centaur runtime that points at one Fly
Surface preview for artifact capture.

Required env:
  ATRIUM_PREVIEW_SURFACE_URL       e.g. https://atrium-prev-...fly.dev
  ARTIFACT_CAPTURE_API_KEY         same key set on that Surface preview
  IRON_CONTROL_BASE_URL            shared preview iron-control URL
  IRON_CONTROL_API_KEY             shared preview iron-control API key

Optional env:
  IRON_CONTROL_NAMESPACE           default: default
  CENTAUR_NAMESPACE                default: centaur
  CENTAUR_RELEASE                  default: centaur
  CENTAUR_LOCAL_REGISTRY           default: localhost:5000
  CENTAUR_IMAGE_TAG                default: current git commit
  CENTAUR_OVERLAY_REF              default: current git commit
  LOCAL_DEV_API_KEY                default: generated and stored in k8s secret
  GITHUB_TOKEN                     used to create centaur-repo-cache-github-token
  SKIP_BUILD=1                     skip Docker builds
  SKIP_PUSH=1                      skip local registry push

Output:
  Prints the CENTAUR_BASE_URL shape and the kubectl command for reading the
  local dev API key from the Kubernetes secret.
USAGE
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
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

rand_hex() {
  openssl rand -hex "${1:-32}"
}

secret_value() {
  local ns="$1" secret="$2" key="$3"
  kubectl -n "$ns" get secret "$secret" -o "jsonpath={.data.${key}}" 2>/dev/null | base64 -d
}

secret_preflight() {
  local ns="$1" release="$2"
  shift 2
  local rendered refs missing=0
  rendered="$(
    cd "$ROOT/centaur"
    helm template "$release" contrib/chart -n "$ns" "$@" 2>&1
  )" || {
    echo "helm template failed during secret preflight:" >&2
    printf '%s\n' "$rendered" | tail -20 >&2
    exit 1
  }

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

  if [ -z "$refs" ]; then
    echo "secret preflight parsed no secret refs; refusing to deploy blind" >&2
    exit 1
  fi

  local name key
  while IFS=$'\t' read -r name key; do
    [ -z "$name" ] && continue
    if [ "$key" = "-" ]; then
      kubectl -n "$ns" get secret "$name" >/dev/null 2>&1 || {
        echo "missing secret: $name" >&2
        missing=1
      }
    else
      kubectl -n "$ns" get secret "$name" -o "jsonpath={.data['$key']}" 2>/dev/null | grep -q . || {
        echo "missing secret key: $name/$key" >&2
        missing=1
      }
    fi
  done <<<"$refs"

  if [ "$missing" = 1 ]; then
    echo "secret preflight failed" >&2
    exit 1
  fi
  echo "secret preflight OK ($(printf '%s\n' "$refs" | wc -l | tr -d ' ') refs)"
}

main() {
  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
    usage
    exit 0
  fi

  load_env
  require_cmd docker
  require_cmd helm
  require_cmd just
  require_cmd kubectl
  require_cmd openssl
  require_env ATRIUM_PREVIEW_SURFACE_URL ARTIFACT_CAPTURE_API_KEY IRON_CONTROL_BASE_URL IRON_CONTROL_API_KEY

  local ns="${CENTAUR_NAMESPACE:-centaur}"
  local release="${CENTAUR_RELEASE:-centaur}"
  local registry="${CENTAUR_LOCAL_REGISTRY:-localhost:5000}"
  local tag="${CENTAUR_IMAGE_TAG:-$(git -C "$ROOT" rev-parse HEAD)}"
  local overlay_ref="${CENTAUR_OVERLAY_REF:-$tag}"
  local ic_namespace="${IRON_CONTROL_NAMESPACE:-default}"
  local local_dev_key="${LOCAL_DEV_API_KEY:-}"
  local helm_args=(
    -f contrib/chart/values.dev.yaml
    -f "$ROOT/infra/values.local.yaml"
    -f "$ROOT/deploy/preview/centaur/values.shared-preview.yaml"
    --set-string "apiRs.image.repository=$registry/library/centaur-api-rs"
    --set-string "apiRs.image.tag=$tag"
    --set-string "ironProxy.image.repository=$registry/library/centaur-iron-proxy"
    --set-string "ironProxy.image.tag=$tag"
    --set-string "sandbox.image.repository=$registry/library/centaur-agent"
    --set-string "sandbox.image.tag=$tag"
    --set-string "nodeSync.image.repository=$registry/library/centaur-node-sync"
    --set-string "nodeSync.image.tag=$tag"
    --set-string "overlays.sources[0].ref=$overlay_ref"
    --set-string "nodeSync.atriumBaseUrl=$ATRIUM_PREVIEW_SURFACE_URL"
    --set-string "apiRs.extraEnv.IRON_CONTROL_URL=$IRON_CONTROL_BASE_URL"
    --set-string "apiRs.extraEnv.IRON_CONTROL_API_KEY=$IRON_CONTROL_API_KEY"
    --set-string "apiRs.extraEnv.IRON_CONTROL_NAMESPACE=$ic_namespace"
  )

  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  if [ -z "$local_dev_key" ]; then
    local_dev_key="$(secret_value "$ns" centaur-infra-env LOCAL_DEV_API_KEY || true)"
  fi
  if [ -z "$local_dev_key" ]; then
    local_dev_key="$(rand_hex 32)"
    echo "generated LOCAL_DEV_API_KEY for Centaur"
  fi

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    kubectl -n "$ns" create secret generic centaur-repo-cache-github-token \
      --from-literal=token="$GITHUB_TOKEN" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  fi

  (
    cd "$ROOT/centaur"
    OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-dummy}" \
      OP_VAULT="${OP_VAULT:-dummy}" \
      SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-dummy}" \
      SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-dummy}" \
      SLACKBOT_API_KEY="${SLACKBOT_API_KEY:-$(rand_hex 32)}" \
      LOCAL_DEV_API_KEY="$local_dev_key" \
      just namespace="$ns" bootstrap-secrets
  )

  kubectl -n "$ns" patch secret centaur-infra-env --type merge \
    -p "{\"stringData\":{\"ARTIFACT_CAPTURE_API_KEY\":\"$ARTIFACT_CAPTURE_API_KEY\"}}" >/dev/null

  (
    cd "$ROOT/centaur"
    helm dependency update contrib/chart >/dev/null
  )
  secret_preflight "$ns" "$release" "${helm_args[@]}"

  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    (
      cd "$ROOT/centaur"
      for svc in api-rs iron-proxy sandbox node-sync; do
        DOCKER_BUILDKIT=1 just build-one "$svc"
      done
    )
  fi

  if [ "${SKIP_PUSH:-0}" != "1" ]; then
    for pair in \
      "api-rs centaur-api-rs" \
      "iron-proxy centaur-iron-proxy" \
      "sandbox centaur-agent" \
      "node-sync centaur-node-sync"
    do
      set -- $pair
      local image="$2"
      docker tag "$image:latest" "$registry/library/$image:$tag"
      docker push "$registry/library/$image:$tag" >/dev/null
      docker tag "$image:latest" "$registry/library/$image:latest"
      docker push "$registry/library/$image:latest" >/dev/null
    done
  fi

  (
    cd "$ROOT/centaur"
    helm upgrade --install "$release" contrib/chart -n "$ns" --create-namespace \
      "${helm_args[@]}"
  )

  kubectl -n "$ns" rollout status "deploy/${release}-centaur-api-rs" --timeout=240s
  kubectl -n "$ns" patch svc "${release}-centaur-api-rs" -p '{"spec":{"type":"NodePort"}}' >/dev/null

  local node_port
  node_port="$(kubectl -n "$ns" get svc "${release}-centaur-api-rs" -o jsonpath='{.spec.ports[0].nodePort}')"
  echo "Centaur ready"
  echo "  node port:        $node_port"
  echo "  CENTAUR_BASE_URL: http://<vm-public-host>:$node_port"
  echo "  CENTAUR_API_KEY:  read LOCAL_DEV_API_KEY from the centaur-infra-env secret"
  echo
  echo "Read the API key on the VM with:"
  echo "  kubectl -n $ns get secret centaur-infra-env -o jsonpath='{.data.LOCAL_DEV_API_KEY}' | base64 -d"
  echo
  echo "Wire a Fly Surface preview with:"
  echo "  deploy/preview/fly/previewctl.sh wire-surface-centaur <surface-fly-app> http://<vm-public-host>:$node_port <LOCAL_DEV_API_KEY>"
}

main "$@"
