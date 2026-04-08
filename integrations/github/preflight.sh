#!/usr/bin/env bash
# shellcheck disable=SC2154  # agent_ids/agent_tokens are loaded by the caller before sourcing this integration.
# GitHub integration — agent credential preflight checks.
#
# Validates agent tokens against the GitHub API. Reads from the
# caller-scoped agent_ids[] and agent_tokens[] arrays populated
# by lib-slots.sh:load_agent_slots().

[ -n "${HIVEMOOT_INTEGRATION_GITHUB_PREFLIGHT_LOADED:-}" ] && return 0
HIVEMOOT_INTEGRATION_GITHUB_PREFLIGHT_LOADED=1

# Validate all agent tokens against GitHub API.
# Args: [require_user_token]
#   require_user_token=1: tokens must be user PATs (needed for notifications API)
#   require_user_token=0 (default): accept both user and installation tokens
# Reads: agent_ids[], agent_tokens[], target_repo (from caller scope)
# Returns: number of failures
github_preflight_creds() {
  local require_user_token="${1:-0}"
  local failures=0

  for index in "${!agent_ids[@]}"; do
    local aid="${agent_ids[$index]}"
    local tok="${agent_tokens[$index]}"

    if [ "$require_user_token" = "1" ]; then
      if ! GH_TOKEN="$tok" gh api user --jq .login >/dev/null 2>&1; then
        echo "Pre-flight: token for agent '${aid}' is not a valid user token (required for WATCH_MENTIONS=1)." >&2
        failures=$((failures + 1))
        continue
      fi
    else
      if ! GH_TOKEN="$tok" gh api user --jq .login >/dev/null 2>&1; then
        if ! GH_TOKEN="$tok" gh api installation --jq .id >/dev/null 2>&1; then
          echo "Pre-flight: token for agent '${aid}' is invalid or expired." >&2
          failures=$((failures + 1))
          continue
        fi
      fi
    fi

    if [ -n "${target_repo:-}" ]; then
      if ! GH_TOKEN="$tok" gh api "repos/${target_repo}" --jq .full_name >/dev/null 2>&1; then
        echo "Pre-flight: token for agent '${aid}' cannot access ${target_repo}." >&2
        failures=$((failures + 1))
      fi
    fi
  done

  return "$failures"
}

# Set up agent-scoped credential env vars before launching run-once.sh.
# Exports AGENT_GITHUB_TOKEN_FILE and clears raw token env vars so the
# child process cannot leak tokens via env inspection.
# Args: token_file
github_prepare_agent_env() {
  local token_file="$1"
  export AGENT_GITHUB_TOKEN_FILE="$token_file"
  unset AGENT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN
}

integration_preflight_creds() {
  github_preflight_creds "$@"
}

integration_prepare_agent_env() {
  github_prepare_agent_env "$@"
}
