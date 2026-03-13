#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[entrypoint %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

load_provider_secrets

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  mkdir -p "${HOME}/.claude"
  # Use a far-future local expiry so Claude Code treats the bootstrap token
  # as non-expired; actual token lifetime is enforced server-side.
  cat > "${HOME}/.claude/.credentials.json" <<CREDS
{"claudeAiOauth":{"accessToken":"${CLAUDE_CODE_OAUTH_TOKEN}","expiresAt":4102444800000}}
CREDS
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

mode="${RUN_MODE:-once}"
case "$mode" in
  once)
    log "Running all agents once in parallel"
    exec /opt/hivemoot-agent/scripts/run-multi.sh
    ;;
  loop)
    echo "WARNING: RUN_MODE=loop (Phase 1 in-container supervisor) is deprecated." >&2
    echo "         Use the host controller instead: bash scripts/controller.sh" >&2
    echo "         See README Host Controller section for migration details." >&2
    exec /opt/hivemoot-agent/scripts/run-loop.sh
    ;;
  task)
    log "Running task mode"
    exec /opt/hivemoot-agent/scripts/run-task.sh
    ;;
  *)
    echo "Invalid RUN_MODE: ${mode}. Expected: once|loop|task" >&2
    exit 1
    ;;
esac
