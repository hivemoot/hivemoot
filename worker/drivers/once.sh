#!/usr/bin/env bash
# Driver: once — execute a single work item and exit.
set -euo pipefail

log() {
  printf '[run-once-driver %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORKER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${WORKER_DIR}/.." && pwd)"
SHARED_DIR="${SHARED_DIR:-${REPO_ROOT}/shared}"
KERNEL_DIR="${KERNEL_DIR:-${WORKER_DIR}}"

# shellcheck source=shared/lib.sh
. "${SHARED_DIR}/lib.sh"

load_provider_secrets
load_identity_plugin
load_workload_plugin
load_workload_integration_preflight

# Public worker contract: AGENT_TOKEN_FILE / AGENT_TOKEN for a single execution.
# Legacy slot-01 env vars remain accepted as compatibility fallbacks.
if [ -z "${AGENT_ID:-}" ] && [ -n "${AGENT_ID_01:-}" ]; then
  export AGENT_ID="${AGENT_ID_01}"
fi

if [ -n "${AGENT_ID:-}" ]; then
  validate_agent_id "${AGENT_ID}"
fi

if [ -z "${AGENT_GITHUB_TOKEN_FILE:-}" ] && [ -z "${AGENT_GITHUB_TOKEN:-}" ]; then
  if [ -n "${AGENT_TOKEN_FILE:-}" ]; then
    integration_prepare_agent_env "${AGENT_TOKEN_FILE}"
  elif [ -n "${AGENT_TOKEN:-}" ]; then
    export AGENT_GITHUB_TOKEN="${AGENT_TOKEN}"
  elif [ -n "${AGENT_GITHUB_TOKEN_01_FILE:-}" ]; then
    integration_prepare_agent_env "${AGENT_GITHUB_TOKEN_01_FILE}"
  elif [ -n "${AGENT_GITHUB_TOKEN_01:-}" ]; then
    export AGENT_GITHUB_TOKEN="${AGENT_GITHUB_TOKEN_01}"
  fi
fi

if [ -n "${AGENT_TOKEN_FILE:-}" ]; then
  export AGENT_TOKEN_FILE
fi

run_once_script="${RUN_ONCE_SCRIPT:-${KERNEL_DIR}/run-once.sh}"

exec "$run_once_script"
