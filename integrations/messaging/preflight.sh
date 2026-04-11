#!/usr/bin/env bash
# shellcheck disable=SC2154
# Messaging integration — preflight credential validation.
#
# Called by the worker driver before run-once.sh.  Self-contained:
# loads the platform adapter if needed before validating credentials.

[ -n "${HIVEMOOT_INTEGRATION_MESSAGING_PREFLIGHT_LOADED:-}" ] && return 0
HIVEMOOT_INTEGRATION_MESSAGING_PREFLIGHT_LOADED=1

_MESSAGING_PREFLIGHT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

integration_preflight_creds() {
  # Ensure the adapter is loaded (idempotent — setup.sh guards itself).
  if ! declare -F messaging_platform_validate_config >/dev/null 2>&1; then
    # shellcheck source=integrations/messaging/setup.sh
    . "${_MESSAGING_PREFLIGHT_DIR}/setup.sh"
    messaging_load_platform || return 1
  fi
  if ! messaging_platform_validate_config; then
    echo "Pre-flight: messaging platform credentials are invalid or missing." >&2
    return 1
  fi
  return 0
}

# Messaging does not wire the agent token into GitHub credentials.
# Repo access is opt-in: operators who want repo-aware messaging set
# AGENT_GITHUB_TOKEN explicitly.
integration_prepare_agent_env() {
  return 0
}
