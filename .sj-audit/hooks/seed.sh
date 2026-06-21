#!/usr/bin/env bash
# seed.sh <persona> — provide login hints for a persona.
#
# Atrium auto-provisions a user on dev-login, so there's little to "seed" on a fresh
# self-host: the agent logs in via the browser (config.login.steps) using the handle below.
# The sessions mock (enabled in launch.sh) supplies the agent surfaces for every persona.
#
# Prints LOGIN_HINT=<...> on stdout. Exits non-zero for personas that can't be live-seeded
# (the skill then treats them as code-only).
set -euo pipefail
persona="${1:-solo}"

case "$persona" in
  solo)
    echo "LOGIN_HINT=handle=ana display=Ana Park (fresh solo workspace, #general only)"
    ;;
  lead)
    # An 'agent-curious lead' evaluating team use — same dev-login, framed as the evaluator.
    echo "LOGIN_HINT=handle=lee display=Lee Park (evaluating Atrium for a team; spawn an @agent session and watch it)"
    ;;
  teammate)
    # A second real human can't be fabricated on a fresh single-user self-host.
    echo "code-only: review the invited-teammate experience from source (invites, DMs, presence, ACLs)." >&2
    exit 1
    ;;
  *)
    echo "unknown persona '$persona'" >&2; exit 2 ;;
esac
