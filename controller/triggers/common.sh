#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2034  # globals are supplied by controller/main.sh; trigger context vars are consumed across sourced files.

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_COMMON_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_COMMON_LOADED=1

if ! declare -p controller_registered_triggers >/dev/null 2>&1; then
  declare -gA controller_registered_triggers=()
fi

normalize_trigger_name() {
  local name="${1:-}"
  printf '%s' "$name"
}

trigger_symbol_name() {
  local name=""
  name="$(normalize_trigger_name "${1:-}")"
  name="${name//-/_}"
  printf '%s' "$name"
}

register_controller_trigger() {
  local trigger_name=""
  trigger_name="$(normalize_trigger_name "$1")"
  controller_registered_triggers["$trigger_name"]=1
}

controller_trigger_is_registered() {
  local trigger_name=""
  trigger_name="$(normalize_trigger_name "${1:-}")"
  [ -n "${controller_registered_triggers[$trigger_name]:-}" ]
}

controller_trigger_hook_name() {
  local hook="$1"
  local trigger_name="$2"
  printf 'controller_trigger_%s__%s' "$hook" "$(trigger_symbol_name "$trigger_name")"
}

controller_invoke_trigger_hook() {
  local hook="$1"
  local trigger_name="$2"
  shift 2

  local fn=""
  local default_fn="controller_trigger_${hook}_default"
  fn="$(controller_trigger_hook_name "$hook" "$trigger_name")"

  if declare -F "$fn" >/dev/null 2>&1; then
    "$fn" "$@"
    return $?
  fi

  if declare -F "$default_fn" >/dev/null 2>&1; then
    "$default_fn" "$@"
    return $?
  fi

  return 0
}

controller_trigger_global_slot_timeout_secs_default() {
  printf '0'
}

controller_trigger_validate_queue_payload_default() {
  return 0
}

controller_trigger_on_duplicate_agent_default() {
  local processing_file="$1"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.done" 2>/dev/null || true
  fi
}

controller_trigger_on_global_slot_timeout_default() {
  local processing_file="$1"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.failed" 2>/dev/null || true
  fi
}

controller_trigger_on_success_default() {
  local processing_file="$1"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.done" 2>/dev/null || true
  fi
  return 0
}

controller_trigger_on_failure_default() {
  local processing_file="$1"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.failed" 2>/dev/null || true
  fi
  return 0
}

requeue_processing_file() {
  local processing_file="$1"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.trigger.json" 2>/dev/null || true
  fi
}

finalize_processing_file() {
  local processing_file="$1"
  local final_state="$2"
  [ -z "$processing_file" ] && return 0
  if [ -f "$processing_file" ]; then
    mv -f "$processing_file" "${processing_file%.processing}.${final_state}" 2>/dev/null || true
  fi
}

write_trigger_file() {
  local trigger_type="$1"
  local repo="$2"
  local agent_id="$3"
  local extra_prompt="$4"
  local ack_key="$5"
  local state_file="$6"
  local session_key="$7"

  local trigger_id=""
  local trigger_file=""
  local temp_file=""

  trigger_type="$(normalize_trigger_name "$trigger_type")"

  trigger_id="$(generate_job_id)"
  trigger_file="${queue_root}/${trigger_id}.trigger.json"
  temp_file="$(mktemp "${queue_root}/.trigger.XXXXXX")"

  if ! jq -n \
    --arg trigger_type "$trigger_type" \
    --arg repo "$repo" \
    --arg agent_id "$agent_id" \
    --arg extra_prompt "$extra_prompt" \
    --arg ack_key "$ack_key" \
    --arg state_file "$state_file" \
    --arg session_key "$session_key" \
    '{
      trigger_type: $trigger_type,
      repo: $repo,
      agent_id: $agent_id,
      extra_prompt: $extra_prompt,
      ack_key: $ack_key,
      state_file: $state_file,
      session_key: $session_key
    }' > "$temp_file"; then
    rm -f "$temp_file" 2>/dev/null || true
    return 1
  fi

  mv "$temp_file" "$trigger_file"
}

