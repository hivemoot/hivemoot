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

# ── Plugin engine dispatch ────────────────────────────────────────
# The Python plugin engine is the sole execution path. Workers are
# oneshot only — long-running triggers live in the controller plane.

if [ -n "${AGENT_TRIGGER:-}" ]; then
  echo "AGENT_TRIGGER is controller-only and is not used by the worker runtime." >&2
  echo "Use controller/main.sh to drive trigger-based runs." >&2
  exit 1
fi

if ! prepare_plugin_engine_dispatch; then
  echo "AGENT_PLUGINS is required. Set it to the plugin stack (e.g. github,hivemoot-github)." >&2
  exit 1
fi

log "Dispatching plugin engine: plugins=${AGENT_PLUGINS}"
exec hivemoot-agent oneshot
