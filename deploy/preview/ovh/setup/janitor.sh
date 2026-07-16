#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../../.." && pwd)"
STATE_DB="${ATRIUM_PREVIEW_STATE_DB:-}"
PREVIEWCTL="${ATRIUM_PREVIEWCTL:-$REPO_ROOT/deploy/preview/ovh/previewctl.py}"

log() {
  printf '%s [janitor] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if [[ -z "$STATE_DB" ]]; then
  for candidate in \
    /var/lib/atrium-preview/state/launcher.sqlite3 \
    "$REPO_ROOT/deploy/preview/ovh/.state/launcher.sqlite3"; do
    if [[ -e "$candidate" ]]; then
      STATE_DB="$candidate"
      break
    fi
  done
  STATE_DB="${STATE_DB:-/var/lib/atrium-preview/state/launcher.sqlite3}"
fi

if [[ ! -e "$STATE_DB" ]]; then
  log "state database does not exist yet; nothing to sweep ($STATE_DB)"
  exit 0
fi

if [[ ! -f "$PREVIEWCTL" ]]; then
  log "preview controller is missing: $PREVIEWCTL"
  exit 1
fi

LOCK_FILE="${ATRIUM_PREVIEW_JANITOR_LOCK:-$(dirname -- "$STATE_DB")/janitor.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another sweep is running; exiting"
  exit 0
fi

query="SELECT id FROM previews WHERE datetime(expires_at) <= datetime('now') AND status NOT IN ('destroying','destroyed','expired') ORDER BY expires_at;"
mapfile -t expired_ids < <(sqlite3 -noheader "$STATE_DB" "$query")

if ((${#expired_ids[@]} == 0)); then
  log "no expired previews"
  exit 0
fi

failures=0
for preview_id in "${expired_ids[@]}"; do
  if [[ ! "$preview_id" =~ ^prev-[a-f0-9]{12}-[a-f0-9]{4}$ ]]; then
    log "refusing malformed preview id from state DB: $preview_id"
    failures=$((failures + 1))
    continue
  fi
  log "sweeping expired preview $preview_id"
  if /usr/bin/python3 "$PREVIEWCTL" destroy "$preview_id"; then
    log "swept $preview_id"
  else
    log "destroy failed for $preview_id; a later sweep will retry"
    failures=$((failures + 1))
  fi
done

log "sweep complete: ${#expired_ids[@]} expired, $failures failed"
exit "$failures"
