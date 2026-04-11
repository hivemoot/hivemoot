#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2034  # globals are supplied by controller/main.sh; trigger context vars are consumed across sourced files.

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_COMMON_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_COMMON_LOADED=1

if ! declare -p controller_registered_triggers >/dev/null 2>&1; then
  declare -gA controller_registered_triggers=()
fi

normalize_trigger_name() {
  local name="${1:-}"

  case "$name" in
    mention|github-mention)
      printf '%s' "github-mention"
      ;;
    review-request|github-review-request)
      printf '%s' "github-review-request"
      ;;
    task|hivemoot-task)
      printf '%s' "hivemoot-task"
      ;;
    *)
      printf '%s' "$name"
      ;;
  esac
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

controller_trigger_worker_workload_default() {
  printf '%s' "${AGENT_WORKLOAD:-hivemoot}"
}

controller_trigger_health_kind_default() {
  printf '%s' "manual"
}

controller_trigger_global_slot_timeout_secs_default() {
  printf '0'
}

controller_trigger_validate_queue_payload_default() {
  return 0
}

controller_trigger_prepare_job_default() {
  return 0
}

controller_trigger_on_global_slot_wait_timeout_default() {
  return 0
}

controller_trigger_on_spawn_failure_default() {
  return 0
}

controller_trigger_after_worker_start_default() {
  return 0
}

controller_trigger_on_worker_exit_default() {
  local exit_code="$5"
  printf '%s\n' "$exit_code"
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

controller_reset_trigger_job_context() {
  controller_trigger_prepared_extra_prompt=""
  controller_trigger_prepared_session_key=""
  controller_trigger_prepared_codex_answer_host_path=""
  controller_trigger_prepared_codex_answer_worker_path=""
  controller_trigger_background_pid=""
  controller_trigger_prepared_job_home=""
  controller_trigger_prepared_persistent_session_dir=""
  controller_trigger_prepared_skip_credential_cleanup=0
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

queue_has_ack_key() {
  local ack_key="$1"
  local ack_key_marker=""
  local existing_file=""
  local existing_ack_key=""
  local now=0
  local mtime=0
  local age_secs=0
  local -a existing_files=()

  if [ -z "$ack_key" ]; then
    return 1
  fi
  ack_key_marker="\"ack_key\": \"${ack_key}\""

  shopt -s nullglob
  existing_files=("${queue_root}"/*.trigger.json "${queue_root}"/*.processing "${queue_root}"/*.done)
  if [ "$watch_trigger_failure_backoff_secs" -gt 0 ]; then
    existing_files+=("${queue_root}"/*.failed)
    now="$(date +%s)"
  fi
  shopt -u nullglob

  for existing_file in "${existing_files[@]}"; do
    [ -f "$existing_file" ] || continue
    if [[ "$existing_file" == *.failed ]]; then
      mtime="$(file_mtime_epoch "$existing_file" "$now")"
      age_secs=$((now - mtime))
      if [ "$age_secs" -gt "$watch_trigger_failure_backoff_secs" ]; then
        continue
      fi
    fi
    if ! grep -Fq "$ack_key_marker" "$existing_file"; then
      continue
    fi
    existing_ack_key="$(jq -r '.ack_key // empty' "$existing_file" 2>/dev/null || true)"
    if [ "$existing_ack_key" = "$ack_key" ]; then
      return 0
    fi
  done

  return 1
}
