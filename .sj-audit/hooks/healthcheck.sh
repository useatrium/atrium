#!/usr/bin/env bash
# healthcheck.sh — exit 0 when the isolated Atrium web is ready to drive.
# A 200 or 401 both count as "up" (the login screen returns 200; the API behind it 401s).
set -euo pipefail
URL="${SJ_BASE_URL:-http://localhost:5173}"
code="$(curl -fsS -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo 000)"
case "$code" in
  200|301|302|401) exit 0 ;;
  *) exit 1 ;;
esac
