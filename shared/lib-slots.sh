#!/usr/bin/env bash
# lib-slots.sh — slot config parsing, token and skill loading, and preflight checks.
#
# Dependencies (must be sourced before this file):
#   scripts/lib.sh  — provides trim(), validate_agent_id(), ensure_skill_files_exist()
#
# Idempotency guard: re-sourcing is a no-op.
[ -n "${HIVEMOOT_LIB_SLOTS_LOADED:-}" ] && return 0
HIVEMOOT_LIB_SLOTS_LOADED=1

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
