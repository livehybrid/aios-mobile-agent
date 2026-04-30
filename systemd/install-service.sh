#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="aios-mobile-agent"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm || true)"
RUN_USER="${SUDO_USER:-$(whoami)}"
RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6 || true)"
if [[ -z "${RUN_HOME}" ]]; then
  RUN_HOME="${HOME}"
fi

if [[ -z "${NPM_BIN}" ]]; then
  echo "npm not found in PATH."
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (or via sudo) to install a systemd service."
  exit 1
fi

# Stop any existing manually started server.js processes from this app,
# otherwise systemd fails with EADDRINUSE on port 3111.
while IFS= read -r pid; do
  [[ -z "${pid}" ]] && continue
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [[ "${cwd}" == "${APP_DIR}" ]]; then
    echo "Stopping existing ${APP_DIR} process (pid ${pid})"
    kill -TERM "${pid}" || true
  fi
done < <(pgrep -f "node server.js" || true)

cat > "${SERVICE_PATH}" <<EOF
[Unit]
Description=AIOS Mobile Agent Web UI
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PATH=${RUN_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStartPre=${APP_DIR}/systemd/kill-stale-server.sh
ExecStart=${NPM_BIN} start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo "Installed and started ${SERVICE_NAME}.service"
systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
