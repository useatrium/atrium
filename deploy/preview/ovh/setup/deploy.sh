#!/usr/bin/env bash
# Sync the preview box's checkout to the repo and reload the launcher when its
# code changes. Runs from a systemd timer (so the box self-heals to the repo and
# can never silently drift — that drift is what stranded an un-pushed local
# branch on the box once) and can be run by hand for an immediate deploy.
#
# It git-operates as the service user (so file ownership stays correct) but must
# run as root to restart the launcher unit — hence a root oneshot that shells to
# `sudo -u`.
set -euo pipefail

REPO="${ATRIUM_PREVIEW_REPO:-/opt/atrium}"
REF="${ATRIUM_PREVIEW_DEPLOY_REF:-origin/master}"
SERVICE_USER="${ATRIUM_PREVIEW_SERVICE_USER:-atrium-preview}"
STATE_DIR="${ATRIUM_PREVIEW_STATE_DIR:-/var/lib/atrium-preview/state}"
DRIFT_DIR="$(dirname "$STATE_DIR")"
LAUNCHER="atrium-preview-launcher.service"

log() { logger -t atrium-preview-deploy -- "$*" 2>/dev/null || true; echo "atrium-preview-deploy: $*"; }
asuser() { sudo -u "$SERVICE_USER" git -C "$REPO" "$@"; }

asuser fetch --quiet --prune origin
before="$(asuser rev-parse HEAD)"
target="$(asuser rev-parse "$REF")"

# Enforce repo state, but never silently eat a hand-edit made on the box: save
# any working-tree drift to a timestamped patch first, so a box hotfix stays
# recoverable instead of vanishing under `reset --hard`.
if ! asuser diff --quiet || ! asuser diff --cached --quiet; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  asuser diff HEAD >"$DRIFT_DIR/drift-$stamp.patch" 2>/dev/null || true
  log "WARNING: discarding local drift in $REPO, saved to $DRIFT_DIR/drift-$stamp.patch"
fi

asuser reset --hard --quiet "$target"

if [ "$before" = "$target" ]; then
  log "already at ${target:0:9}; no deploy"
  exit 0
fi
printf '%s\n' "$target" >"$DRIFT_DIR/deployed-sha"
log "deployed ${before:0:9} -> ${target:0:9} ($REF)"

# Restart the launcher only when its own code changed. `_create_worker` runs in
# a launcher thread, so a restart mid-create would orphan a half-built preview
# (a leaked k3d cluster + compose project), so defer while any preview is
# provisioning — the next timer run picks it up.
if asuser diff --quiet "$before" "$target" -- deploy/preview/ovh/; then
  log "launcher code unchanged; no restart"
  exit 0
fi

provisioning="$(python3 - "$STATE_DIR" <<'PY'
import glob, json, sys
n = 0
for f in glob.glob(f"{sys.argv[1]}/*.json"):
    try:
        if json.load(open(f)).get("status") == "provisioning":
            n += 1
    except Exception:
        pass
print(n)
PY
)"
if [ "${provisioning:-0}" != "0" ]; then
  log "launcher code changed but ${provisioning} preview(s) provisioning; deferring restart"
  exit 0
fi

systemctl restart "$LAUNCHER"
log "restarted $LAUNCHER (preview code changed)"
