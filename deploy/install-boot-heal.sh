#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-boot-heal.sh must be run as root" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/boot-heal.service"
UNIT_DST="/etc/systemd/system/boot-heal.service"

install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable boot-heal.service

echo "Installed $UNIT_DST"
echo "Enabled boot-heal.service"
