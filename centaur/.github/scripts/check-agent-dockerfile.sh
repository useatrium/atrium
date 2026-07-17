#!/usr/bin/env bash
# Guards against silent drift between the two agent Dockerfiles.
#
# Atrium runs a slimmed agent image built from services/sandbox/Dockerfile.agent
# (selected via CENTAUR_AGENT_DOCKERFILE). Its `toolchain` stage deliberately
# differs from upstream's services/sandbox/Dockerfile — that's the whole point.
# But its FINAL stage (everything from `FROM toolchain AS sandbox` onward) is a
# verbatim copy of upstream's: the COPY --link manifest, the harness-server build,
# and the baked prompt/overlay wiring must stay in lockstep, or the slim image
# silently ships without a file the fat image just gained on an upstream pull.
#
# This asserts those final stages are byte-for-byte identical. When it fails after
# an upstream pull, port upstream's final-stage change into Dockerfile.agent too.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fat="$here/services/sandbox/Dockerfile"
slim="$here/services/sandbox/Dockerfile.agent"

for f in "$fat" "$slim"; do
  [ -f "$f" ] || { echo "check-agent-dockerfile: missing $f" >&2; exit 2; }
done

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
  exit 1
fi
