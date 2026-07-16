#!/usr/bin/env bash
set -euo pipefail

CLUSTER="poc-ovlprop"
KUBECONFIG_FILE="$(mktemp)"
MANIFEST_DIR="$(mktemp -d)"
RESULT="INCONCLUSIVE"

cleanup() {
  k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  sudo rm -rf /var/lib/pocov /run/pocmerged >/dev/null 2>&1 || true
  rm -rf "$KUBECONFIG_FILE" "$MANIFEST_DIR" >/dev/null 2>&1 || true
}

finish() {
  local status=$?
  trap - EXIT
  cleanup
  if ((status != 0)); then
    RESULT="INCONCLUSIVE"
  fi
  printf 'POC_RESULT=%s\n' "$RESULT"
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

kubectl() {
  sudo k3s kubectl --kubeconfig "$KUBECONFIG_FILE" "$@"
}

wait_for_default_service_account() {
  local attempt
  for attempt in $(seq 1 120); do
    if kubectl get sa/default >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_reader() {
  local attempt phase
  for ((attempt = 1; attempt <= 150; attempt++)); do
    phase="$(kubectl get pod reader -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded | Failed)
        return 0
        ;;
    esac
    sleep 1
  done
  return 1
}

main() {
  sudo mkdir -p /var/lib/pocov /run/pocmerged
  sudo chmod 777 /var/lib/pocov /run/pocmerged

  k3d cluster create "$CLUSTER" \
    --no-lb \
    --k3s-arg "--disable=traefik@server:0" \
    --k3s-arg "--disable=servicelb@server:0" \
    --volume /var/lib/pocov:/var/lib/pocov@server:0 \
    --volume /run/pocmerged:/run/pocmerged@server:0 \
    --wait \
    --timeout 180s

  k3d kubeconfig get "$CLUSTER" >"$KUBECONFIG_FILE"
  kubectl wait --for=condition=Ready node --all --timeout=180s
  if ! wait_for_default_service_account; then
    printf 'default service account did not appear\n' >&2
    return 1
  fi

  cat >"$MANIFEST_DIR/reader.yaml" <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: reader
spec:
  restartPolicy: Never
  containers:
    - name: reader
      image: ubuntu:22.04
      command: ["/bin/bash", "-ceu"]
      args:
        - |
          for _ in $(seq 1 120); do
            if [[ -f /mnt/merged/s1/from_overlay.txt ]]; then
              echo READER_SEES_OVERLAY=YES
              exit 0
            fi
            sleep 1
          done
          echo READER_SEES_OVERLAY=NO
          exit 1
      volumeMounts:
        - name: merged
          mountPath: /mnt/merged
          mountPropagation: HostToContainer
  volumes:
    - name: merged
      hostPath:
        path: /run/pocmerged
        type: Directory
YAML

  cat >"$MANIFEST_DIR/mounter.yaml" <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: mounter
spec:
  restartPolicy: Never
  containers:
    - name: mounter
      image: ubuntu:22.04
      securityContext:
        privileged: true
      command: ["/bin/bash", "-ceu"]
      args:
        - |
          mkdir -p /var/lib/pocov/lower /var/lib/pocov/upper /var/lib/pocov/work /run/pocmerged/s1
          printf 'lower\n' >/var/lib/pocov/lower/from_lower.txt
          sleep 20
          mount -t overlay overlay -o lowerdir=/var/lib/pocov/lower,upperdir=/var/lib/pocov/upper,workdir=/var/lib/pocov/work,metacopy=off /run/pocmerged/s1
          printf 'overlay\n' >/run/pocmerged/s1/from_overlay.txt
          sleep 15
      volumeMounts:
        - name: state
          mountPath: /var/lib/pocov
        - name: merged
          mountPath: /run/pocmerged
          mountPropagation: Bidirectional
  volumes:
    - name: state
      hostPath:
        path: /var/lib/pocov
        type: Directory
    - name: merged
      hostPath:
        path: /run/pocmerged
        type: Directory
YAML

  kubectl apply -f "$MANIFEST_DIR/reader.yaml"
  kubectl wait --for=condition=Ready pod/reader --timeout=120s
  kubectl apply -f "$MANIFEST_DIR/mounter.yaml"

  if ! wait_for_reader; then
    printf 'reader pod did not finish within 150 seconds\n' >&2
  fi

  local logs
  logs="$(kubectl logs reader 2>&1 || true)"
  printf '%s\n' "$logs"
  if grep -q 'READER_SEES_OVERLAY=YES' <<<"$logs"; then
    RESULT="CONFIRMED"
  elif grep -q 'READER_SEES_OVERLAY=NO' <<<"$logs"; then
    RESULT="DISPROVED"
  fi
}

main
