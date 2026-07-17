#!/usr/bin/env bash
# Guards against silent drift between the two agent Dockerfiles.
#
# Atrium runs a slimmed agent image built from services/sandbox/Dockerfile.agent
# (selected via CENTAUR_AGENT_DOCKERFILE). Its `toolchain` stage deliberately
# differs from upstream's services/sandbox/Dockerfile — that's the whole point.
# Shared toolchain version pins and its FINAL stage (everything from
# `FROM toolchain AS sandbox` onward) must stay in lockstep with upstream's, or
# the slim image can silently ship a stale tool or omit a file added upstream.
#
# This asserts shared ARG *_VERSION pins, the agent-browser npm pin, and the pip
# install block match, and that final stages are byte-for-byte identical. Pins for
# tools intentionally omitted from the slim image are ignored.
set -euo pipefail
export LC_ALL=C

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fat="$here/services/sandbox/Dockerfile"
slim="$here/services/sandbox/Dockerfile.agent"

for f in "$fat" "$slim"; do
  [ -f "$f" ] || { echo "check-agent-dockerfile: missing $f" >&2; exit 2; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failed=0

extract_version_args() {
  awk '$1 == "ARG" && $2 ~ /^[A-Za-z_][A-Za-z0-9_]*_VERSION=/ { print $2 }' "$1" | sort
}

extract_agent_browser_pin() {
  awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^agent-browser@/) {
        print $i
      }
    }
  }' "$1"
}

extract_pip_pin_block() {
  awk '
    /^[[:space:]]*pip3 install --break-system-packages/ { capture = 1 }
    capture && /^[[:space:]]*&& / { exit }
    capture { print }
  ' "$1"
}

compare_pin_files() {
  description="$1"
  remediation="$2"
  fat_pins="$3"
  slim_pins="$4"

  if diff -u "$fat_pins" "$slim_pins"; then
    echo "check-agent-dockerfile: $description match"
  else
    cat >&2 <<EOF

check-agent-dockerfile: FAIL — $description have diverged.
$remediation
EOF
    failed=1
  fi
}

extract_version_args "$fat" >"$tmp/fat.version-args"
extract_version_args "$slim" >"$tmp/slim.version-args"
cut -d= -f1 "$tmp/fat.version-args" >"$tmp/fat.version-names"
cut -d= -f1 "$tmp/slim.version-args" >"$tmp/slim.version-names"
comm -12 "$tmp/fat.version-names" "$tmp/slim.version-names" >"$tmp/shared.version-names"

: >"$tmp/Dockerfile.shared-version-args"
: >"$tmp/Dockerfile.agent.shared-version-args"
while IFS= read -r name; do
  awk -v name="$name" 'index($0, name "=") == 1 { print }' \
    "$tmp/fat.version-args" >>"$tmp/Dockerfile.shared-version-args"
  awk -v name="$name" 'index($0, name "=") == 1 { print }' \
    "$tmp/slim.version-args" >>"$tmp/Dockerfile.agent.shared-version-args"
done <"$tmp/shared.version-names"

extract_agent_browser_pin "$fat" >"$tmp/Dockerfile.agent-browser-pin"
extract_agent_browser_pin "$slim" >"$tmp/Dockerfile.agent.agent-browser-pin"
extract_pip_pin_block "$fat" >"$tmp/Dockerfile.pip-pin-block"
extract_pip_pin_block "$slim" >"$tmp/Dockerfile.agent.pip-pin-block"

compare_pin_files \
  "shared ARG *_VERSION pins" \
  "Apply the shared version bump to both services/sandbox/Dockerfile and Dockerfile.agent." \
  "$tmp/Dockerfile.shared-version-args" \
  "$tmp/Dockerfile.agent.shared-version-args"
compare_pin_files \
  "agent-browser npm pins" \
  "Apply the agent-browser version bump to both services/sandbox/Dockerfile and Dockerfile.agent." \
  "$tmp/Dockerfile.agent-browser-pin" \
  "$tmp/Dockerfile.agent.agent-browser-pin"
compare_pin_files \
  "pip install pin blocks" \
  "Keep the complete pip3 install --break-system-packages block identical in both agent Dockerfiles." \
  "$tmp/Dockerfile.pip-pin-block" \
  "$tmp/Dockerfile.agent.pip-pin-block"

marker='^FROM toolchain AS sandbox'
grep -q "$marker" "$fat"  || { echo "check-agent-dockerfile: no sandbox stage in $fat" >&2; exit 2; }
grep -q "$marker" "$slim" || { echo "check-agent-dockerfile: no sandbox stage in $slim" >&2; exit 2; }

if diff -u <(sed -n "/$marker/,\$p" "$fat") <(sed -n "/$marker/,\$p" "$slim"); then
  echo "check-agent-dockerfile: final stages match"
else
  cat >&2 <<'EOF'

check-agent-dockerfile: FAIL — the final (sandbox) stages have diverged.
The slim agent image (Dockerfile.agent) must copy upstream's final stage verbatim.
Port the upstream change (shown above) into services/sandbox/Dockerfile.agent.
EOF
  failed=1
fi

exit "$failed"
