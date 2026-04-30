#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while IFS= read -r pid; do
  [[ -z "${pid}" ]] && continue
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [[ "${cwd}" == "${APP_DIR}" ]]; then
    echo "Stopping stale ${APP_DIR} process (pid ${pid})"
    kill -TERM "${pid}" || true
  fi
done < <(pgrep -f "node server.js" || true)
