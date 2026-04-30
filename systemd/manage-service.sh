#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="aios-mobile-agent.service"
ACTION="${1:-status}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (or via sudo) to manage ${SERVICE_NAME}."
  exit 1
fi

case "${ACTION}" in
  start|stop|restart|status)
    systemctl "${ACTION}" "${SERVICE_NAME}"
    ;;
  logs)
    journalctl -u "${SERVICE_NAME}" -f -n 200
    ;;
  enable|disable)
    systemctl "${ACTION}" "${SERVICE_NAME}"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|enable|disable}"
    exit 1
    ;;
esac
