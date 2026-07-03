#!/usr/bin/env bash
# deploy/registry-gc.sh — bound the local image registry (registry:3 on
# 127.0.0.1:5000). redeploy.sh pushes a SHA-tagged copy of every Centaur image on
# every deploy and nothing else deletes the old ones, so the registry volume grows
# without limit. This deletes stale tags, then runs the registry's mark-and-sweep
# garbage collector to reclaim the blobs.
#
# RETENTION (a tag is KEPT if it is in either set — deleted only if in neither):
#   • IN USE   — referenced by any running pod OR any Sandbox CR podTemplate.
#                Protects live sessions AND paused/resumable sandboxes that pin an
#                older image SHA (those resume by re-pulling that exact tag).
#   • RECENT   — among the last $KEEP_COMMITS deploy commits (git short SHAs), for
#                rollback headroom. The tag IS the short git SHA (see redeploy.sh).
#
# REQUIRES registry:3 (CNCF distribution v3) with deletes enabled. v3's GC correctly
# follows OCI image-index → blob references; registry:2's did NOT and deleted in-use
# blobs (it corrupted the live registry once). deploy/setup-registry.sh provisions v3.
# As a safety net this script re-verifies every in-use image still resolves AFTER GC
# and fails loudly if any regressed. Safe to re-run; a no-op when nothing is stale.
#
# Run from a host cron / systemd timer, e.g. daily:
#   0 4 * * *  /home/ubuntu/atrium/deploy/registry-gc.sh >> /var/log/registry-gc.log 2>&1
set -uo pipefail

REPO_DIR="${ATRIUM_REPO_DIR:-$HOME/atrium}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
PORT="${REGISTRY_PORT:-5000}"
API="http://127.0.0.1:${PORT}"
KEEP_COMMITS="${KEEP_COMMITS:-10}"
# Advertise every manifest type the images might be stored as — BuildKit pushes an
# OCI image index, which the registry 404s unless its media type is in Accept.
ACCEPT='Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
log(){ echo "[$(date +%H:%M:%S)] registry-gc: $*"; }

# --- keep-sets -------------------------------------------------------------------
# In-use tags (strip the localhost:PORT/library/ prefix -> "<repo>:<tag>").
in_use="$(
  { kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{range .spec.initContainers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null
    kubectl get sandbox -A -o jsonpath='{range .items[*]}{range .spec.podTemplate.spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null
  } | grep -oE "localhost:${PORT}/library/[^: ]+:[A-Za-z0-9_.-]+" \
    | sed -E "s#^localhost:${PORT}/library/##" | sort -u
)"
recent="$(git -C "$REPO_DIR" log --format=%h -n "$KEEP_COMMITS" 2>/dev/null | sort -u || true)"
log "protecting $(grep -c . <<<"$in_use") in-use tag(s) + last ${KEEP_COMMITS} commit(s)"

keep_tag(){  # repo tag -> 0 if it must be kept
  local repo="$1" tag="$2"
  grep -qxF "${repo}:${tag}" <<<"$in_use" && return 0
  grep -qxF "$tag" <<<"$recent" && return 0
  return 1
}
manifest_digest(){  # repo tag -> Docker-Content-Digest (empty if unresolved)
  curl -fsSI -H "$ACCEPT" "${API}/v2/$1/manifests/$2" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
}

# --- delete stale tags -----------------------------------------------------------
mapfile -t repos < <(curl -fsS "${API}/v2/_catalog" 2>/dev/null | tr ',' '\n' \
  | grep -oE '"[^"]*centaur-[^"]*"' | tr -d '"' | sort -u)
[ "${#repos[@]}" -eq 0 ] && { log "no repos found (registry unreachable?) — nothing to do"; exit 0; }

# Delete by manifest DIGEST, not by tag: `DELETE .../manifests/<digest>` untags EVERY
# tag pointing at that manifest. So a digest is deletable only when NONE of its tags
# are kept — otherwise deleting a stale tag (e.g. `:latest`, which shares the current
# SHA's digest) would nuke a kept image. Group tags by digest, keep the digest if any
# of its tags is kept.
deleted=0 kept=0
for repo in "${repos[@]}"; do
  mapfile -t tags < <(curl -fsS "${API}/v2/${repo}/tags/list" 2>/dev/null \
    | tr ',' '\n' | grep -oE '"[A-Za-z0-9_.-]+"' | tr -d '"' | grep -vx tags | grep -vx name || true)
  declare -A alldig=() keepdig=()
  for tag in "${tags[@]:-}"; do
    [ -z "$tag" ] && continue
    d="$(manifest_digest "$repo" "$tag")"
    [ -z "$d" ] && { log "  ${repo}:${tag} — no digest, skip"; continue; }
    alldig[$d]=1
    keep_tag "${repo#library/}" "$tag" && keepdig[$d]=1
  done
  for d in "${!alldig[@]}"; do
    if [ -n "${keepdig[$d]:-}" ]; then kept=$((kept+1)); continue; fi
    if curl -fsS -X DELETE "${API}/v2/${repo}/manifests/${d}" >/dev/null 2>&1; then
      deleted=$((deleted+1))
    else
      log "  ${repo}@${d} — DELETE failed (is the registry delete-enabled?)"
    fi
  done
  unset alldig keepdig
done
log "manifests: deleted=${deleted} kept=${kept}"

# --- reclaim blobs (registry:3 mark-and-sweep) -----------------------------------
if [ "$deleted" -gt 0 ]; then
  log "garbage-collect"
  # v3 config path is /etc/distribution/config.yml; fall back to the v2 path.
  sudo docker exec registry registry garbage-collect --delete-untagged /etc/distribution/config.yml >/dev/null 2>&1 \
    || sudo docker exec registry registry garbage-collect --delete-untagged /etc/docker/registry/config.yml >/dev/null 2>&1 \
    || log "garbage-collect failed"
fi

# --- SAFETY NET: every in-use image must still resolve after GC -------------------
# registry:2's GC silently deleted in-use blobs; if a bad registry version ever slips
# back in, catch it here instead of at the next pod pull.
broken=0
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  repo="library/${ref%%:*}"; tag="${ref##*:}"
  if [ -z "$(manifest_digest "$repo" "$tag")" ]; then
    log "❌ IN-USE IMAGE BROKEN AFTER GC: ${ref} — re-push it and check the registry version!"
    broken=$((broken+1))
  fi
done <<<"$in_use"
[ "$broken" -gt 0 ] && { log "FAILED: ${broken} in-use image(s) unresolvable post-GC"; exit 1; }
log "done (in-use images verified intact)"
