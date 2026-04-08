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
IDENTITIES_BASE_DIR="${IDENTITIES_BASE_DIR:-${HIVEMOOT_ROOT_DIR}/identities}"
WORKLOADS_BASE_DIR="${WORKLOADS_BASE_DIR:-${HIVEMOOT_ROOT_DIR}/workloads}"
INTEGRATIONS_BASE_DIR="${INTEGRATIONS_BASE_DIR:-${HIVEMOOT_ROOT_DIR}/integrations}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

resolve_effective_auth_mode() {
  local provider="$1"
  local configured_auth_mode="${2:-auto}"

  case "$configured_auth_mode" in
    api_key|subscription)
      printf '%s' "$configured_auth_mode"
      return 0
      ;;
    auto|'')
      ;;
    *)
      return 1
      ;;
  esac

  case "$provider" in
    codex)
      if [ -n "${OPENAI_API_KEY:-}" ]; then
        printf 'api_key'
      else
        printf 'subscription'
      fi
      ;;
    gemini)
      if [ -n "${GOOGLE_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ]; then
        printf 'api_key'
      else
        printf 'subscription'
      fi
      ;;
    claude)
      if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        printf 'api_key'
      else
        printf 'subscription'
      fi
      ;;
    kilo)
      if [ -n "${KILOCODE_TOKEN:-}" ] || [ -n "${KILO_PROVIDER:-}" ]; then
        printf 'api_key'
      else
        printf 'subscription'
      fi
      ;;
    opencode)
      if [ -n "${OPENCODE_PROVIDER:-}" ]; then
        printf 'api_key'
      else
        printf 'subscription'
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_managed_agent_home() {
  local workspace_root="$1"
  local agent_id="$2"
  local effective_auth_mode="${3:-api_key}"

  if [ "$effective_auth_mode" = "subscription" ]; then
    printf '%s/homes/%s' "$workspace_root" "$agent_id"
  else
    printf '/tmp/hivemoot-agent-home/agents/%s' "$agent_id"
  fi
}

resolve_job_home() {
  local workspace_root="$1"
  local job_id="$2"
  local effective_auth_mode="${3:-api_key}"

  if [ "$effective_auth_mode" = "subscription" ]; then
    printf '%s/%s/home' "$workspace_root" "$job_id"
  else
    printf '/tmp/hivemoot-agent-home/jobs/%s' "$job_id"
  fi
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

strip_frontmatter() {
  local file="$1"
  awk 'BEGIN{fm=0} /^---$/ && fm<2 {fm++; next} fm>=2||fm==0{print}' "$file"
}

ensure_skill_files_exist() {
  local skills_list="$1"
  local skills_dir="${2:-/opt/hivemoot-agent/skills}"
  local context="${3:-AGENT_SKILLS=${skills_list}}"

  [ -z "$skills_list" ] && return 0

  local skill skill_file
  while IFS= read -r skill; do
    skill="$(trim "$skill")"
    [ -z "$skill" ] && continue
    case "$skill" in
      *[!a-zA-Z0-9_-]*)
        echo "Invalid skill name: '${skill}' (${context})" >&2
        return 1
        ;;
    esac
    skill_file="${skills_dir}/${skill}/SKILL.md"
    if [ ! -f "$skill_file" ]; then
      echo "Skill file not found: ${skill_file} (${context})" >&2
      return 1
    fi
  done < <(tr ',' '\n' <<< "$skills_list")
}

load_skill_prompts() {
  local skills_list="$1"
  local skills_dir="${2:-/opt/hivemoot-agent/skills}"

  [ -z "$skills_list" ] && return 0

  if ! ensure_skill_files_exist "$skills_list" "$skills_dir" "AGENT_SKILLS=${skills_list}"; then
    return 1
  fi

  local skill skill_file result="" first=1
  while IFS= read -r skill; do
    skill="$(trim "$skill")"
    [ -z "$skill" ] && continue
    skill_file="${skills_dir}/${skill}/SKILL.md"
    local body
    body="$(strip_frontmatter "$skill_file")"
    if [ "$first" -eq 1 ]; then
      result="<skill name=\"${skill}\">
${body}
</skill>"
      first=0
    else
      result="${result}

<skill name=\"${skill}\">
${body}
</skill>"
    fi
  done < <(tr ',' '\n' <<< "$skills_list")

  printf '%s' "$result"
}

# Generate an ephemeral Claude --plugin-dir layout from a skill list.
# Writes the following structure to a new temp directory:
#
#   <tmpdir>/.claude-plugin/plugin.json
#   <tmpdir>/skills/<name>/SKILL.md     (copied from skills_dir)
#
# Returns the temp directory path on stdout on success.
# On error, removes the temp directory and returns non-zero.
# Callers must register the returned path for cleanup (e.g. _cleanup_dirs+=).
#
# Pass "all" as skills_list to auto-discover every skill in skills_dir.
generate_claude_plugin_dir() {
  local skills_list="$1"
  local skills_dir="${2:-/opt/hivemoot-agent/skills}"

  [ -z "$skills_list" ] && return 0

  # Resolve "all" to every subdirectory containing SKILL.md.
  if [ "$skills_list" = "all" ]; then
    local discovered="" sep=""
    local entry
    for entry in "${skills_dir}"/*/SKILL.md; do
      [ -f "$entry" ] || continue
      local dirname
      dirname="$(basename "$(dirname "$entry")")"
      discovered="${discovered}${sep}${dirname}"
      sep=","
    done
    if [ -z "$discovered" ]; then
      echo "generate_claude_plugin_dir: no skills found in ${skills_dir}" >&2
      return 1
    fi
    skills_list="$discovered"
  fi

  local plugin_dir
  plugin_dir="$(mktemp -d)" || { echo "generate_claude_plugin_dir: mktemp -d failed" >&2; return 1; }

  mkdir -p "${plugin_dir}/.claude-plugin" || { rm -rf "$plugin_dir"; return 1; }
  printf '{"name":"hivemoot-skills","version":"1.0.0","description":"Composable skill modules for hivemoot-agent"}\n' \
    > "${plugin_dir}/.claude-plugin/plugin.json" || { rm -rf "$plugin_dir"; return 1; }

  local skills_plugin_dir
  skills_plugin_dir="${plugin_dir}/skills"
  mkdir -p "$skills_plugin_dir" || { rm -rf "$plugin_dir"; return 1; }

  local skill skill_file
  while IFS= read -r skill; do
    skill="$(trim "$skill")"
    [ -z "$skill" ] && continue
    case "$skill" in
      *[!a-zA-Z0-9_-]*)
        echo "Invalid skill name: '${skill}' (AGENT_AVAILABLE_SKILLS=${skills_list})" >&2
        rm -rf "$plugin_dir"
        return 1
        ;;
    esac
    skill_file="${skills_dir}/${skill}/SKILL.md"
    if [ ! -f "$skill_file" ]; then
      echo "Skill file not found: ${skill_file} (AGENT_AVAILABLE_SKILLS=${skills_list})" >&2
      rm -rf "$plugin_dir"
      return 1
    fi
    mkdir -p "${skills_plugin_dir}/${skill}" || { rm -rf "$plugin_dir"; return 1; }
    cp "$skill_file" "${skills_plugin_dir}/${skill}/SKILL.md" || { rm -rf "$plugin_dir"; return 1; }
  done < <(tr ',' '\n' <<< "$skills_list")

  printf '%s' "$plugin_dir"
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

# ── Plugin Loaders ────────────────────────────────────────────────
# Shared functions to load identity and workload plugins. Replaces the
# 25-line boilerplate blocks that were duplicated in every script.

load_identity_plugin() {
  local name="${AGENT_IDENTITY:-}"
  local dir=""
  local file=""
  if [ -z "$name" ]; then
    echo "AGENT_IDENTITY is required. Set it to the identity name (e.g. hivemoot-agent)." >&2
    exit 1
  fi
  dir="${IDENTITY_DIR:-${IDENTITIES_BASE_DIR}/${name}}"
  file="${dir}/identity.sh"
  if [ ! -f "$file" ]; then
    echo "Identity plugin not found: ${file}" >&2
    exit 1
  fi
  # shellcheck source=identities/hivemoot-agent/identity.sh
  # shellcheck disable=SC1090,SC1091
  . "$file"
}

load_workload_plugin() {
  local name="${AGENT_WORKLOAD:-}"
  local dir=""
  local file=""
  if [ -z "$name" ]; then
    echo "AGENT_WORKLOAD is required. Set it to the workload name (e.g. hivemoot, hivemoot-task)." >&2
    exit 1
  fi
  dir="${WORKLOAD_DIR:-${WORKLOADS_BASE_DIR}/${name}}"
  file="${dir}/workload.sh"
  if [ ! -f "$file" ]; then
    echo "Workload plugin not found: ${file}" >&2
    exit 1
  fi
  # shellcheck source=workloads/hivemoot/workload.sh
  # shellcheck disable=SC1090,SC1091
  . "$file"
}

workload_integration() {
  printf '%s' ""
}

workload_preflight() {
  return 0
}

workload_setup() {
  return 0
}

workload_build_prompt() {
  echo "Workload plugin must define workload_build_prompt()." >&2
  return 1
}

workload_user_message() {
  echo "Workload plugin must define workload_user_message()." >&2
  return 1
}

workload_skills_dir() {
  printf '%s' ""
}

integration_preflight_creds() {
  return 0
}

integration_prepare_agent_env() {
  return 0
}

load_workload_integration_preflight() {
  local name=""
  local dir=""
  local file=""

  name="$(workload_integration)"
  [ -z "$name" ] && return 0

  dir="${INTEGRATION_DIR:-${INTEGRATIONS_BASE_DIR}}/${name}"
  file="${dir}/preflight.sh"
  if [ ! -f "$file" ]; then
    echo "Integration preflight plugin not found: ${file}" >&2
    exit 1
  fi

  # shellcheck source=integrations/github/preflight.sh
  # shellcheck disable=SC1090,SC1091
  . "$file"
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

preflight_check_agent_skill_lists() {
  local skills_dir="${1:-/opt/hivemoot-agent/skills}"
  local agent_id=""
  local skills_list=""
  local failures=0
  declare -A checked_skill_lists=()

  # shellcheck disable=SC2154  # agent_ids is optionally declared by controller-side slot loading.
  if declare -p agent_ids >/dev/null 2>&1 && [ "${#agent_ids[@]}" -gt 0 ]; then
    for agent_id in "${agent_ids[@]}"; do
      skills_list="$(resolve_agent_skill_list "$agent_id")"
      [ -z "$skills_list" ] && continue
      if [ -n "${checked_skill_lists[$skills_list]:-}" ]; then
        continue
      fi
      checked_skill_lists["$skills_list"]=1
      if ! ensure_skill_files_exist "$skills_list" "$skills_dir" "AGENT_SKILLS(${agent_id})=${skills_list}"; then
        failures=$((failures + 1))
      fi
    done
    return "$failures"
  fi

  skills_list="$(trim "${AGENT_SKILLS:-}")"
  if [ -n "$skills_list" ]; then
    agent_id="${AGENT_ID:-${AGENT_ID_01:-default}}"
    if ! ensure_skill_files_exist "$skills_list" "$skills_dir" "AGENT_SKILLS(${agent_id})=${skills_list}"; then
      failures=$((failures + 1))
    fi
  fi

  return "$failures"
}

preflight_check_provider_auth() {
  local provider="$1"
  local auth_mode="${2:-auto}"
  local failures=0

  # Provider auth check
  case "$provider" in
    codex)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( [ -n "${OPENAI_API_KEY:-}" ] && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "Pre-flight: OPENAI_API_KEY missing for codex + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    gemini)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( { [ -n "${GOOGLE_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ]; } && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "Pre-flight: GOOGLE_API_KEY/GEMINI_API_KEY missing for gemini + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    claude)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        echo "Pre-flight: ANTHROPIC_API_KEY missing for claude + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    kilo)
      if [ -z "${KILOCODE_TOKEN:-}" ]; then
        if [ -z "${KILO_PROVIDER:-}" ]; then
          echo "Pre-flight: KILO_PROVIDER is required for kilo (unless KILOCODE_TOKEN is set for gateway mode)." >&2
          failures=$((failures + 1))
        else
          case "${KILO_PROVIDER}" in
            anthropic)
              if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
                echo "Pre-flight: ANTHROPIC_API_KEY missing for KILO_PROVIDER=anthropic." >&2
                failures=$((failures + 1))
              fi
              ;;
            openai)
              if [ -z "${OPENAI_API_KEY:-}" ]; then
                echo "Pre-flight: OPENAI_API_KEY missing for KILO_PROVIDER=openai." >&2
                failures=$((failures + 1))
              fi
              ;;
            google)
              if [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
                echo "Pre-flight: GOOGLE_API_KEY/GEMINI_API_KEY missing for KILO_PROVIDER=google." >&2
                failures=$((failures + 1))
              fi
              ;;
            openrouter)
              if [ -z "${OPENROUTER_API_KEY:-}" ]; then
                echo "Pre-flight: OPENROUTER_API_KEY missing for KILO_PROVIDER=openrouter." >&2
                failures=$((failures + 1))
              fi
              ;;
          esac
        fi
      fi
      ;;
    opencode)
      if [ -n "${OPENCODE_PROVIDER:-}" ]; then
        case "${OPENCODE_PROVIDER}" in
          zai)
            if [ -z "${ZAI_API_KEY:-}" ]; then
              echo "Pre-flight: ZAI_API_KEY missing for OPENCODE_PROVIDER=zai." >&2
              failures=$((failures + 1))
            fi
            ;;
        esac
      elif [ ! -f "/home/node/.local/share/opencode/auth.json" ]; then
        echo "Pre-flight: OpenCode auth not configured. Set OPENCODE_PROVIDER + API key, or run: opencode auth login." >&2
        failures=$((failures + 1))
      fi
      ;;
  esac

  return "$failures"
}

seed_provider_home() {
  local shared_path="$1"
  local agent_path="$2"

  if [ ! -e "$shared_path" ]; then
    return 0
  fi

  if [ -d "$shared_path" ]; then
    mkdir -p "$agent_path"
    cp -R "$shared_path"/. "$agent_path"/
  else
    mkdir -p "$(dirname "$agent_path")"
    cp "$shared_path" "$agent_path"
  fi
}

# Managed-mode seeding: copy shared provider state into each isolated
# agent home. This intentionally mirrors directory-level provider data.
seed_shared_provider_state() {
  local agent_home="$1"
  local source_home="${2:-/home/node}"

  seed_provider_home "${source_home}/.codex" "${agent_home}/.codex"
  seed_provider_home "${source_home}/.gemini" "${agent_home}/.gemini"
  seed_provider_home "${source_home}/.claude" "${agent_home}/.claude"
  seed_provider_home "${source_home}/.claude.json" "${agent_home}/.claude.json"
  seed_provider_home "${source_home}/.config/claude" "${agent_home}/.config/claude"
  seed_provider_home "${source_home}/.config/kilo" "${agent_home}/.config/kilo"
  seed_provider_home "${source_home}/.config/opencode" "${agent_home}/.config/opencode"
  seed_provider_home "${source_home}/.local/share/opencode" "${agent_home}/.local/share/opencode"
}

# Selective auth seeding: copy only credential files for a provider,
# skipping conversation caches and session state. Use this instead of
# seed_provider_home when JOB_ID isolation is active.
seed_provider_auth() {
  local agent_home="$1"
  local source_home="${2:-/home/node}"

  # Claude Code: auth tokens in ~/.config/claude/
  if [ -d "${source_home}/.config/claude" ]; then
    mkdir -p "${agent_home}/.config/claude"
    cp -R "${source_home}/.config/claude"/. "${agent_home}/.config/claude"/
  fi
  # Claude Code: ~/.claude/ contains both auth and session state.
  # Seed only the OAuth credential file; skip auto-memory and projects/.
  if [ -f "${source_home}/.claude/.credentials.json" ]; then
    mkdir -p "${agent_home}/.claude"
    cp "${source_home}/.claude/.credentials.json" "${agent_home}/.claude/.credentials.json"
  fi
  if [ -f "${source_home}/.claude.json" ]; then
    cp "${source_home}/.claude.json" "${agent_home}/.claude.json"
  fi

  # Codex: only auth.json
  if [ -f "${source_home}/.codex/auth.json" ]; then
    mkdir -p "${agent_home}/.codex"
    cp "${source_home}/.codex/auth.json" "${agent_home}/.codex/auth.json"
  fi
  # Codex: skip conversations/, cache/

  # Gemini: seed auth/credential files + settings.json (contains auth method
  # selection); skip session state (memory.md, state.json, telemetry, etc.)
  if [ -d "${source_home}/.gemini" ]; then
    mkdir -p "${agent_home}/.gemini"
    for f in oauth_creds.json google_accounts.json settings.json mcp-oauth-tokens.json mcp-oauth-tokens-v2.json .env; do
      if [ -f "${source_home}/.gemini/$f" ]; then
        cp "${source_home}/.gemini/$f" "${agent_home}/.gemini/$f"
      fi
    done
  fi

  # Kilo: config directory holds provider auth and permission settings
  if [ -d "${source_home}/.config/kilo" ]; then
    mkdir -p "${agent_home}/.config/kilo"
    cp -R "${source_home}/.config/kilo"/. "${agent_home}/.config/kilo"/
  fi

  # OpenCode: config directory holds provider auth and permission settings
  if [ -d "${source_home}/.config/opencode" ]; then
    mkdir -p "${agent_home}/.config/opencode"
    cp -R "${source_home}/.config/opencode"/. "${agent_home}/.config/opencode"/
  fi
  # OpenCode: auth credentials from ~/.local/share/opencode/
  if [ -f "${source_home}/.local/share/opencode/auth.json" ]; then
    mkdir -p "${agent_home}/.local/share/opencode"
    cp "${source_home}/.local/share/opencode/auth.json" "${agent_home}/.local/share/opencode/auth.json"
  fi

  # OpenCode: auto-generate config and auth.json if missing
  generate_opencode_config "$agent_home"
}

# Create standard agent home subdirectories, seed provider auth credentials,
# and write a .profile so agent subprocesses can find npm-installed binaries.
# Call this once per agent before launching run-once.sh.
init_agent_home() {
  local agent_home="$1"

  mkdir -p \
    "$agent_home/.config" \
    "$agent_home/.cache" \
    "$agent_home/.local" \
    "$agent_home/.local/share"
  chmod 700 \
    "$agent_home/.config" \
    "$agent_home/.cache" \
    "$agent_home/.local" \
    "$agent_home/.local/share" 2>/dev/null || true

  # Seed only auth credentials into each agent home; skip session state
  # (conversation caches, memory, history) to prevent cross-run leakage.
  seed_provider_auth "$agent_home"

  # Login shells (bash -lc) reset PATH from /etc/profile, losing the
  # Docker ENV that includes the npm global bin directory. Write a
  # .profile so agent subprocesses (codex/gemini/claude CLI tools)
  # can find hivemoot and other npm-installed binaries.
  # shellcheck disable=SC2016  # literal ${PATH} intended for .profile
  printf 'export PATH="/usr/local/share/npm-global/bin:${PATH}"\n' \
    > "$agent_home/.profile"
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
