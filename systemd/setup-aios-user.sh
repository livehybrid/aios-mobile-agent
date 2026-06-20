#!/usr/bin/env bash
# Create the dedicated service account for AIOS / mobile-agent (idempotent).
# Run as root. Home is /var/lib/aios; the git checkout should live under /opt/aios.
set -euo pipefail

RUN_USER="${AIOS_SERVICE_USER:-aios}"
RUN_HOME="${AIOS_SERVICE_HOME:-/var/lib/aios}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (or via sudo)."
  exit 1
fi

if getent passwd "${RUN_USER}" >/dev/null; then
  echo "User ${RUN_USER} already exists."
  exit 0
fi

useradd --system \
  --home-dir "${RUN_HOME}" \
  --create-home \
  --shell /usr/sbin/nologin \
  "${RUN_USER}"

echo "Created system user ${RUN_USER} (home ${RUN_HOME})."
