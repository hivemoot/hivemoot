#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[entrypoint %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARED_DIR="${SHARED_DIR:-${REPO_ROOT}/shared}"
# shellcheck source=shared/lib.sh
. "${SHARED_DIR}/lib.sh"

DRIVER_DIR="${DRIVER_DIR:-${RUNNER_DIR:-${SCRIPT_DIR}/drivers}}"

load_provider_secrets

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  claude_credentials_json="$(jq -cn --arg token "$CLAUDE_CODE_OAUTH_TOKEN" '{claudeAiOauth:{accessToken:$token,expiresAt:4102444800000}}')"
  mkdir -p "${HOME}/.claude"
  # Use a far-future local expiry so Claude Code treats the bootstrap token
  # as non-expired; actual token lifetime is enforced server-side.
  printf '%s\n' "$claude_credentials_json" > "${HOME}/.claude/.credentials.json"
  cat > "${HOME}/.claude.json" <<'JSON'
{"hasCompletedOnboarding":true}
JSON
  chmod 600 "${HOME}/.claude/.credentials.json"
  chmod 600 "${HOME}/.claude.json"
fi

docker_provider="${DOCKER_PROVIDER:-all}"
agent_provider="${AGENT_PROVIDER:-claude}"
if [ "$docker_provider" != "all" ] && [ "$docker_provider" != "$agent_provider" ]; then
  echo "Provider mismatch: image built for '${docker_provider}' but AGENT_PROVIDER='${agent_provider}'." >&2
  echo "  Use baked provider: set AGENT_PROVIDER=${docker_provider} in .env" >&2
  echo "  Switch providers:   PROVIDER=${agent_provider} docker compose build hivemoot-agent" >&2
  exit 1
fi

# ── Workload ──────────────────────────────────────────────────────
load_workload_plugin

# ── Driver Dispatch ───────────────────────────────────────────────
# AGENT_DRIVER is the public worker-plane execution selector.
# AGENT_RUNNER remains as a temporary compatibility alias during migration.
if [ -n "${AGENT_TRIGGER:-}" ]; then
  echo "AGENT_TRIGGER is controller-only and is not used by the worker runtime." >&2
  echo "Set AGENT_DRIVER=once|loop for direct container execution, or use controller/main.sh." >&2
  exit 1
fi

driver="${AGENT_DRIVER:-${AGENT_RUNNER:-once}}"
if [ "$driver" = "task" ]; then
  echo "Driver 'task' has been removed. Task lifecycle is controller-owned; use AGENT_DRIVER=once for workers." >&2
  exit 1
fi

driver_file="${DRIVER_DIR}/${driver}.sh"

if [ ! -f "$driver_file" ]; then
  echo "Driver not found: ${driver_file}" >&2
  echo "Available drivers: $(for f in "${DRIVER_DIR}"/*.sh; do [ -f "$f" ] && basename "$f" .sh; done | tr '\n' ', ' | sed 's/,$//')" >&2
  exit 1
fi

log "Dispatching: workload=${AGENT_WORKLOAD} driver=${driver}"
exec "$driver_file"
