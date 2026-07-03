#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${ATRIUM_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SERVICE_NAME="${ATRIUM_TURN_RENEW_SERVICE:-atrium-renew-turn-cert}"
INSTALL_PATH="${ATRIUM_TURN_RENEW_PATH:-/usr/local/sbin/atrium-renew-turn-cert}"

sudo_cmd=()
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  sudo_cmd=(sudo)
fi

tmp="$(mktemp)"
cat > "$tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ATRIUM_REPO_DIR="\${ATRIUM_REPO_DIR:-$REPO_DIR}"
exec "\$ATRIUM_REPO_DIR/surface/deploy/renew-turn-cert.sh"
EOF

"${sudo_cmd[@]}" install -m 0755 "$tmp" "$INSTALL_PATH"
rm -f "$tmp"

"${sudo_cmd[@]}" tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<EOF
[Unit]
Description=Renew Atrium TURN TLS certificate
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH
EOF

"${sudo_cmd[@]}" tee "/etc/systemd/system/$SERVICE_NAME.timer" >/dev/null <<EOF
[Unit]
Description=Daily Atrium TURN TLS certificate renewal

[Timer]
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF

"${sudo_cmd[@]}" systemctl daemon-reload
"${sudo_cmd[@]}" systemctl enable --now "$SERVICE_NAME.timer"
"${sudo_cmd[@]}" systemctl list-timers --all "$SERVICE_NAME.timer"
