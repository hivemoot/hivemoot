#!/usr/bin/env bash
set -euo pipefail

# lib.sh is a sourced library; avoid "return" errors when run directly.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "scripts/lib.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_LIB_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_LIB_LOADED=1

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
# run-multi.sh, run-once.sh) so new provider keys only need adding here.
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

prompt_requires_companion_base() {
  local prompt_file="$1"

  case "$prompt_file" in
    /opt/hivemoot-agent/prompts/system/autonomous.md|/opt/hivemoot-agent/prompts/system/task.md)
      return 0
      ;;
  esac

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

# Deterministic offset within an interval for staggered scheduling.
# md5(repo:agent_id) % interval → seconds. Spreads agents evenly so
# they never cluster at the same wake-up time.
compute_agent_offset() {
  local repo="$1"
  local agent_id="$2"
  local interval="$3"
  local hash_input="${repo}:${agent_id}"
  local hash_hex=""

  if [ "$interval" -le 1 ]; then
    printf '0'
    return 0
  fi

  # Use first 8 hex digits (32 bits) — enough for any practical interval.
  # md5sum on Linux, md5 on macOS.
  if command -v md5sum >/dev/null 2>&1; then
    hash_hex="$(printf '%s' "$hash_input" | md5sum | cut -c1-8)"
  elif command -v md5 >/dev/null 2>&1; then
    hash_hex="$(printf '%s' "$hash_input" | md5 -q | cut -c1-8)"
  else
    # Fallback: cksum is POSIX and always available
    local cksum_val=""
    cksum_val="$(printf '%s' "$hash_input" | cksum | cut -d' ' -f1)"
    printf '%s' "$((cksum_val % interval))"
    return 0
  fi

  # Guard against empty output — an empty hash_hex would cause a bash
  # arithmetic syntax error in the 16# expansion below.
  if [ -z "$hash_hex" ]; then
    printf '0'
    return 0
  fi

  # shellcheck disable=SC2004  # 16# prefix requires no $ on hash_hex
  printf '%s' "$(( 16#${hash_hex} % interval ))"
}

load_slot_token() {
  local suffix="$1"
  local token_var="AGENT_GITHUB_TOKEN_${suffix}"
  local token_file_var="${token_var}_FILE"
  local token="${!token_var:-}"
  local token_file="${!token_file_var:-}"

  if [ -n "$token" ] && [ -n "$token_file" ]; then
    echo "Set either ${token_var} or ${token_file_var}, not both." >&2
    exit 1
  fi

  if [ -z "$token" ] && [ -n "$token_file" ]; then
    if [ ! -f "$token_file" ]; then
      echo "${token_file_var} does not exist: ${token_file}" >&2
      exit 1
    fi
    token="$(tr -d '\r\n' < "$token_file")"
  fi

  printf '%s' "$token"
}

load_slot_skills() {
  local suffix="$1"
  local skills_var="AGENT_SKILLS_${suffix}"
  printf '%s' "$(trim "${!skills_var:-}")"
}

# Populate caller-declared seen_agents, agent_ids, and agent_tokens by reading
# AGENT_ID_XX / AGENT_GITHUB_TOKEN_XX(_FILE) env vars for slots 1..<max_slots>.
# If the caller declares agent_skill_lists as an associative array, populate it
# from optional AGENT_SKILLS_XX values for matching slots.
# Arrays must be declared in the caller scope before calling this function:
#   declare -A seen_agents=()
#   declare -a agent_ids=()
#   declare -a agent_tokens=()
#   declare -A agent_skill_lists=()
load_agent_slots() {
  local max_slots="${1:-10}"
  local slot suffix id_var token_var token_file_var skills_var
  local agent_id agent_token token_inline token_file agent_skill_list
  local populate_skill_lists=0

  if declare -p agent_skill_lists >/dev/null 2>&1; then
    populate_skill_lists=1
  fi

  for slot in $(seq 1 "$max_slots"); do
    suffix="$(printf '%02d' "$slot")"
    id_var="AGENT_ID_${suffix}"
    token_var="AGENT_GITHUB_TOKEN_${suffix}"
    token_file_var="${token_var}_FILE"
    skills_var="AGENT_SKILLS_${suffix}"

    agent_id="$(trim "${!id_var:-}")"
    token_inline="${!token_var:-}"
    token_file="${!token_file_var:-}"
    agent_skill_list="$(load_slot_skills "$suffix")"

    if [ -z "$agent_id" ] && [ -z "$token_inline" ] && [ -z "$token_file" ] && [ -z "$agent_skill_list" ]; then
      continue
    fi

    if [ -z "$agent_id" ]; then
      echo "${id_var} is required when ${token_var}, ${token_file_var}, or ${skills_var} is set." >&2
      exit 1
    fi

    agent_token="$(load_slot_token "$suffix")"
    if [ -z "$agent_token" ]; then
      echo "Missing token for slot ${suffix}. Set ${token_var} or ${token_file_var}." >&2
      exit 1
    fi

    validate_agent_id "$agent_id"

    if [ -n "${seen_agents[$agent_id]:-}" ]; then
      echo "Duplicate agent id detected: ${agent_id}" >&2
      exit 1
    fi
    seen_agents["$agent_id"]=1

    agent_ids+=("$agent_id")
    agent_tokens+=("$agent_token")
    if [ "$populate_skill_lists" -eq 1 ] && [ -n "$agent_skill_list" ]; then
      agent_skill_lists["$agent_id"]="$agent_skill_list"
    fi
  done

  if [ "${#agent_ids[@]}" -eq 0 ]; then
    echo "No agents configured. Set AGENT_ID_01 + AGENT_GITHUB_TOKEN_01 (up to _10)." >&2
    exit 1
  fi
}

resolve_agent_skill_list() {
  local agent_id="$1"
  local fallback="${2:-${AGENT_SKILLS:-}}"

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

prepare_hivemoot_cli() {
  local update_mode="${HIVEMOOT_CLI_UPDATE:-auto}"
  local spec="@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION:-latest}"

  if [ "$update_mode" = "skip" ]; then
    log "Pre-run: skipping hivemoot CLI update (HIVEMOOT_CLI_UPDATE=skip)"
  else
    log "Pre-run: updating hivemoot CLI (${spec})"
    npm install -g "$spec"
    hash -r
  fi

  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "hivemoot CLI is not available. Rebuild the image or set HIVEMOOT_CLI_UPDATE=auto." >&2
    exit 1
  fi

  local version_line=""
  version_line="$(hivemoot --version 2>/dev/null | head -n 1 || true)"
  if [ -n "$version_line" ]; then
    log "Pre-run: hivemoot CLI ready (${version_line})"
  else
    log "Pre-run: hivemoot CLI ready"
  fi
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
