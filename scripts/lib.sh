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
  local var_value="${!var_name:-}"
  local file_value="${!file_var_name:-}"

  if [ -n "$var_value" ] || [ -z "$file_value" ]; then
    return 0
  fi

  if [ ! -f "$file_value" ]; then
    echo "${file_var_name} is set but file does not exist: ${file_value}" >&2
    exit 1
  fi

  var_value="$(tr -d '\r\n' < "$file_value")"
  printf -v "$var_name" '%s' "$var_value"
  # shellcheck disable=SC2163  # dynamic export of the variable named in $var_name
  export "$var_name"
}

# Load all provider API secrets from their corresponding *_FILE env vars.
# Called at startup in every entrypoint (entrypoint.sh, run-loop.sh,
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

validate_target_repo() {
  local target_repo="$1"

  if [ -z "$target_repo" ]; then
    echo "TARGET_REPO is required. Set it as owner/repo." >&2
    exit 1
  fi

  if ! printf '%s' "$target_repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
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

# Populate caller-declared seen_agents, agent_ids, and agent_tokens by reading
# AGENT_ID_XX / AGENT_GITHUB_TOKEN_XX(_FILE) env vars for slots 1..<max_slots>.
# Arrays must be declared in the caller scope before calling this function:
#   declare -A seen_agents=()
#   declare -a agent_ids=()
#   declare -a agent_tokens=()
load_agent_slots() {
  local max_slots="${1:-10}"
  local slot suffix id_var token_var token_file_var
  local agent_id agent_token token_inline token_file

  for slot in $(seq 1 "$max_slots"); do
    suffix="$(printf '%02d' "$slot")"
    id_var="AGENT_ID_${suffix}"
    token_var="AGENT_GITHUB_TOKEN_${suffix}"
    token_file_var="${token_var}_FILE"

    agent_id="$(trim "${!id_var:-}")"
    token_inline="${!token_var:-}"
    token_file="${!token_file_var:-}"

    if [ -z "$agent_id" ] && [ -z "$token_inline" ] && [ -z "$token_file" ]; then
      continue
    fi

    if [ -z "$agent_id" ]; then
      echo "${id_var} is required when ${token_var} or ${token_file_var} is set." >&2
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
  done

  if [ "${#agent_ids[@]}" -eq 0 ]; then
    echo "No agents configured. Set AGENT_ID_01 + AGENT_GITHUB_TOKEN_01 (up to _10)." >&2
    exit 1
  fi
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

  # Gemini: seed only known auth/credential files; skip session state
  # (memory.md, settings.json, state.json, telemetry, etc.)
  if [ -d "${source_home}/.gemini" ]; then
    mkdir -p "${agent_home}/.gemini"
    for f in oauth_creds.json google_accounts.json mcp-oauth-tokens.json mcp-oauth-tokens-v2.json .env; do
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

# Append a structured JSON event to an NDJSON events file.
# Each call emits one JSON object per line (newline-delimited JSON).
# Usage: log_event <events_file> <event_name> <agent_id> <run_id> <event_seq> [extra_fields]
# extra_fields: raw JSON field list (no outer braces), e.g. '"duration_secs":42,"outcome":"success"'
log_event() {
  local events_file="$1"
  local event_name="$2"
  local agent_id="$3"
  local run_id="$4"
  local event_seq="$5"
  local extra="${6:-}"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ -n "$extra" ]; then
    printf '{"event":"%s","agent_id":"%s","run_id":"%s","event_seq":%d,"timestamp":"%s",%s}\n' \
      "$event_name" "$agent_id" "$run_id" "$event_seq" "$ts" "$extra" >> "$events_file"
  else
    printf '{"event":"%s","agent_id":"%s","run_id":"%s","event_seq":%d,"timestamp":"%s"}\n' \
      "$event_name" "$agent_id" "$run_id" "$event_seq" "$ts" >> "$events_file"
  fi
}

# Write an agent health snapshot atomically via temp-file + mv.
# Readers never observe a partial write. Overwrites the previous snapshot.
# Usage: write_health_snapshot <health_file> <agent_id> <run_id> <last_event> <consecutive_failures>
write_health_snapshot() {
  local health_file="$1"
  local agent_id="$2"
  local run_id="$3"
  local last_event="$4"
  local consecutive_failures="${5:-0}"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local tmp_file="${health_file}.tmp.$$"
  printf '{"agent_id":"%s","run_id":"%s","last_event":"%s","consecutive_failures":%d,"updated_at":"%s"}\n' \
    "$agent_id" "$run_id" "$last_event" "$consecutive_failures" "$ts" > "$tmp_file"
  mv "$tmp_file" "$health_file"
}

# Atomically increment persistent agent run/error counters.
# Uses the same temp+mv pattern as write_health_snapshot.
# Prints "run_count\terror_count" after the increment so callers can
# capture the updated values without a second read.
# Usage: update_agent_stats <stats_file> <is_error>
#   is_error: 1 if the run failed, 0 otherwise
update_agent_stats() {
  local stats_file="$1"
  local is_error="${2:-0}"
  local run_count=0
  local error_count=0
  local ts

  if [ -f "$stats_file" ] && command -v jq >/dev/null 2>&1; then
    run_count="$(jq -r '.run_count // 0' "$stats_file" 2>/dev/null || printf '0')"
    error_count="$(jq -r '.error_count // 0' "$stats_file" 2>/dev/null || printf '0')"
  fi

  run_count=$((run_count + 1))
  if [ "$is_error" -eq 1 ]; then
    error_count=$((error_count + 1))
  fi

  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local stats_dir
  stats_dir="$(dirname "$stats_file")"
  mkdir -p "$stats_dir"
  local tmp_file="${stats_file}.tmp.$$"
  printf '{"run_count":%d,"error_count":%d,"updated_at":"%s"}\n' \
    "$run_count" "$error_count" "$ts" > "$tmp_file"
  mv "$tmp_file" "$stats_file"

  printf '%d\t%d' "$run_count" "$error_count"
}
