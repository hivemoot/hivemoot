#!/usr/bin/env bash
set -euo pipefail

# lib.sh is a sourced library; avoid "return" errors when run directly.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "shared/lib.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_LIB_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_LIB_LOADED=1

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HIVEMOOT_ROOT_DIR="${HIVEMOOT_ROOT_DIR:-$(cd "${LIB_DIR}/.." && pwd)}"
INTEGRATIONS_BASE_DIR="${INTEGRATIONS_BASE_DIR:-${HIVEMOOT_ROOT_DIR}/integrations}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_secret_from_file() {
  local var_name="$1"
  local file_var_name="${var_name}_FILE"
  local var_value=""

  if ! var_value="$(resolve_secret_value "$var_name")"; then
    exit 1
  fi

  if [ -z "$var_value" ]; then
    return 0
  fi

  printf -v "$var_name" '%s' "$var_value"
  # shellcheck disable=SC2163  # dynamic export of the variable named in $var_name
  export "$var_name"
  # Clear _FILE after promoting to bare var so repeated calls (e.g.
  # run-task.sh → run-once.sh both call load_secret_from_file) don't
  # trip resolve_secret_value's mutual-exclusion guard.
  unset "$file_var_name"
}

# Resolve secret value without mutating env so callers can consume a secret
# locally while still forwarding *_FILE to child processes when needed.
resolve_secret_value() {
  local var_name="$1"
  local file_var_name="${var_name}_FILE"
  local var_value="${!var_name:-}"
  local file_value="${!file_var_name:-}"

  if [ -n "$var_value" ] && [ -n "$file_value" ]; then
    echo "Set either ${var_name} or ${file_var_name}, not both." >&2
    return 1
  fi

  if [ -n "$var_value" ]; then
    printf '%s' "$var_value"
    return 0
  fi

  if [ -z "$file_value" ]; then
    return 0
  fi

  if [ ! -f "$file_value" ]; then
    echo "${file_var_name} is set but file does not exist: ${file_value}" >&2
    return 1
  fi

  tr -d '\r\n' < "$file_value"
}

# Load all provider API secrets from their corresponding *_FILE env vars.
# Called at startup in every entrypoint (entrypoint.sh, run-loop.sh [deprecated],
# run-once.sh) so new provider keys only need adding here.
load_provider_secrets() {
  local secret_var
  for secret_var in \
    OPENAI_API_KEY \
    GOOGLE_API_KEY \
    GEMINI_API_KEY \
    ANTHROPIC_API_KEY \
    OPENROUTER_API_KEY \
    CLAUDE_CODE_OAUTH_TOKEN \
    KILOCODE_TOKEN \
    ZAI_API_KEY
  do
    load_secret_from_file "$secret_var"
  done
}

repo_name_is_valid() {
  local repo_name="$1"
  local repo_segment=""

  if ! printf '%s' "$repo_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$'; then
    return 1
  fi

  repo_segment="${repo_name#*/}"
  case "$repo_segment" in
    .|..)
      return 1
      ;;
  esac

  return 0
}

validate_target_repo() {
  local target_repo="$1"

  if [ -z "$target_repo" ]; then
    echo "TARGET_REPO is required. Set it as owner/repo." >&2
    exit 1
  fi

  if ! repo_name_is_valid "$target_repo"; then
    echo "Invalid TARGET_REPO: ${target_repo}. Expected owner/repo." >&2
    exit 1
  fi
}

bridge_plugin_github_token_env() {
  if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
    return 0
  fi

  if [ -n "${GH_TOKEN:-}" ]; then
    export GITHUB_TOKEN="${GH_TOKEN}"
    return 0
  fi

  if [ -n "${AGENT_GITHUB_TOKEN_FILE:-}" ]; then
    export GITHUB_TOKEN_FILE="${AGENT_GITHUB_TOKEN_FILE}"
    return 0
  fi
  if [ -n "${AGENT_GITHUB_TOKEN:-}" ]; then
    export GITHUB_TOKEN="${AGENT_GITHUB_TOKEN}"
    return 0
  fi

  if [ -n "${AGENT_TOKEN_FILE:-}" ]; then
    export GITHUB_TOKEN_FILE="${AGENT_TOKEN_FILE}"
    return 0
  fi
  if [ -n "${AGENT_TOKEN:-}" ]; then
    export GITHUB_TOKEN="${AGENT_TOKEN}"
    return 0
  fi

  if [ -n "${AGENT_GITHUB_TOKEN_01_FILE:-}" ]; then
    export GITHUB_TOKEN_FILE="${AGENT_GITHUB_TOKEN_01_FILE}"
    return 0
  fi
  if [ -n "${AGENT_GITHUB_TOKEN_01:-}" ]; then
    export GITHUB_TOKEN="${AGENT_GITHUB_TOKEN_01}"
  fi
}

prepare_plugin_engine_dispatch() {
  if [ -z "${AGENT_PLUGINS:-}" ]; then
    return 1
  fi

  if [ -n "${TARGET_REPO:-}" ]; then
    validate_target_repo "${TARGET_REPO}"
    if [ -z "${GITHUB_REPOS:-}" ]; then
      export GITHUB_REPOS="${TARGET_REPO}"
    fi
  fi

  if [ -z "${GITHUB_CLONE_DEPTH:-}" ] && [ -n "${GIT_CLONE_DEPTH:-}" ]; then
    export GITHUB_CLONE_DEPTH="${GIT_CLONE_DEPTH}"
  fi

  bridge_plugin_github_token_env
  return 0
}

validate_workspace_root() {
  local workspace_root="$1"

  case "$workspace_root" in
    /*) ;;
    *)
      echo "WORKSPACE_ROOT must be an absolute path" >&2
      exit 1
      ;;
  esac
}

resolve_companion_base_prompt() {
  local prompt_file="$1"
  local sibling_base_file=""

  sibling_base_file="$(dirname "$prompt_file")/base.md"
  if [ "$sibling_base_file" = "$prompt_file" ]; then
    return 1
  fi

  if [ -f "$sibling_base_file" ]; then
    printf '%s' "$sibling_base_file"
    return 0
  fi

  return 1
}

validate_agent_id() {
  local agent_id="$1"

  case "$agent_id" in
    ''|*[!a-zA-Z0-9_-]*)
      echo "Invalid AGENT_ID: ${agent_id}" >&2
      exit 1
      ;;
  esac
}

validate_job_id() {
  local job_id="$1"

  case "$job_id" in
    ''|*[!a-zA-Z0-9_-]*)
      echo "Invalid JOB_ID: ${job_id}. Use only letters, digits, hyphens, and underscores." >&2
      exit 1
      ;;
  esac
}

# Returns 0 if task_id is safe for use in paths and URLs, 1 otherwise.
# Allowed: alphanumeric, hyphens, underscores, dots (no slashes, no whitespace).
# Explicitly rejected: empty string, bare "." and "..".
task_id_is_valid() {
  local task_id="$1"
  case "$task_id" in
    ''|.|..|*[!A-Za-z0-9._-]*)
      return 1
      ;;
  esac
  return 0
}

validate_task_id() {
  local task_id="$1"
  if ! task_id_is_valid "$task_id"; then
    echo "Invalid task_id: ${task_id}" >&2
    exit 1
  fi
}

validate_url_scheme() {
  local url="$1"
  local name="${2:-URL}"
  case "$url" in
    https://*|http://*) return 0 ;;
    *)
      echo "${name} must begin with https:// or http://, got: ${url}" >&2
      return 1
      ;;
  esac
}

require_non_negative_integer() {
  local name="$1"
  local value="$2"

  case "$value" in
    ''|*[!0-9]*)
      echo "${name} must be a non-negative integer" >&2
      exit 1
      ;;
  esac
}

require_positive_integer() {
  local name="$1"
  local value="$2"

  require_non_negative_integer "$name" "$value"
  if [ "$value" -le 0 ]; then
    echo "${name} must be > 0" >&2
    exit 1
  fi
}

# Generic skill resolution helpers live here.
# Slot loading stays in shared/lib-slots.sh.

resolve_agent_skill_list() {
  local agent_id="$1"
  local fallback="${2:-${AGENT_SKILLS:-}}"

  # shellcheck disable=SC2154  # agent_skill_lists is optionally declared by controller-side slot loading.
  if declare -p agent_skill_lists >/dev/null 2>&1; then
    if [ "${agent_skill_lists[$agent_id]+_}" = "_" ]; then
      printf '%s' "${agent_skill_lists[$agent_id]}"
      return 0
    fi
  fi

  printf '%s' "$fallback"
}

# Remove all files registered in the caller's temp_token_files array.
# Callers must declare: declare -a temp_token_files=()
# Uses the defensive [@]- expansion so an empty array never triggers
# "unbound variable" under set -u.
cleanup_temp_tokens() {
  local path=""
  for path in "${temp_token_files[@]-}"; do
    rm -f "$path" 2>/dev/null || true
  done
}
