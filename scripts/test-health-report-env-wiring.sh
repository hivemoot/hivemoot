#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
CONTROLLER_FILE="${REPO_ROOT}/scripts/controller.sh"

required_vars=(
  HEALTH_REPORT_URL
  HIVEMOOT_AGENT_TOKEN
  HIVEMOOT_AGENT_TOKEN_FILE
  HEALTH_REPORT_TIMEOUT_SECS
  HEALTH_REPORT_MAX_RETRIES
  HEALTH_REPORT_RUN_SUMMARY
)

fail=0
for var in "${required_vars[@]}"; do
  pattern="^[[:space:]]+${var}:[[:space:]]+\\$\\{${var}:-"
  if ! grep -Eq "$pattern" "$COMPOSE_FILE"; then
    echo "Missing docker-compose env wiring for ${var}" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: health reporting env vars are wired into docker-compose runtime env"

# Controller forwarding check — HEALTH_REPORT_* vars must be forwarded via append_env_if_set.
# HIVEMOOT_AGENT_TOKEN / _FILE use append_secret_env (a different forwarding path) and are
# excluded here.  Any HEALTH_REPORT_* var added to required_vars above but missing from the
# controller spawn_worker function will fail this check.
for var in "${required_vars[@]}"; do
  [[ "$var" != HEALTH_REPORT_* ]] && continue
  if ! grep -q "append_env_if_set ${var}" "$CONTROLLER_FILE"; then
    echo "Missing controller.sh append_env_if_set forwarding for ${var}" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: HEALTH_REPORT_* vars are forwarded via append_env_if_set in controller.sh"
