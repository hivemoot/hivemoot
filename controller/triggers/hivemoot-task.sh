#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2034  # globals are supplied by controller/main.sh; prepared trigger context vars are consumed by controller/core/jobs.sh.

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_TASK_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_TASK_LOADED=1

register_controller_trigger "hivemoot-task"

HIVEMOOT_TASK_PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/cli/hivemoot_agent/plugins_builtin/hivemoot_task"

controller_trigger_worker_plugins__hivemoot_task() {
  printf '%s' "${TASK_DISPATCH_PLUGINS:-hivemoot-identity,github,hivemoot-task}"
}

controller_trigger_health_kind__hivemoot_task() {
  printf '%s' "task"
}

controller_trigger_global_slot_timeout_secs__hivemoot_task() {
  printf '%s' "$global_slot_timeout_task_secs"
}

render_task_messages_block() {
  local messages_source_file="$1"

  if [ ! -f "$messages_source_file" ]; then
    echo "Task messages file not found: ${messages_source_file}" >&2
    return 1
  fi

  jq -r '
    if type != "array" then
      error("task messages payload must be an array")
    elif length == 0 then
      ""
    else
      "## Conversation Context\n"
      + "Use this complete timeline as additional context for follow-up/reopened work.\n\n"
      + (
          to_entries
          | map(
              "### Message " + ((.key + 1) | tostring)
              + " (" + ((.value.role // "unknown") | tostring)
              + " @ " + ((.value.created_at // "unknown") | tostring) + ")\n"
              + ((.value.content // "") | tostring)
            )
          | join("\n\n")
        )
    end
  ' "$messages_source_file"
}

extract_codex_result_markdown() {
  local log_path="$1"
  local sidecar_path="${CODEX_ANSWER_FILE:-}"
  local encoded_message=""

  if [ -n "$sidecar_path" ] && [ -s "$sidecar_path" ]; then
    cat "$sidecar_path"
    return 0
  fi

  if [ ! -f "$log_path" ]; then
    return 0
  fi

  encoded_message="$(
    jq -Rr '
      fromjson?
      | select(.type=="item.completed")
      | .item
      | select(.type=="agent_message")
      | .text // empty
      | @base64
    ' "$log_path" | tail -n 1
  )"

  if [ -n "$encoded_message" ]; then
    printf '%s\n' "$encoded_message" | jq -Rr '@base64d'
  fi
}

extract_text_result_from_log() {
  local log_path="$1"

  if [ -f "$log_path" ] && [ -s "$log_path" ]; then
    cat "$log_path"
  fi
}

extract_claude_result_markdown() {
  local log_path="$1"
  local encoded_result=""

  if [ ! -f "$log_path" ]; then
    return 0
  fi

  encoded_result="$(
    jq -Rr '
      fromjson?
      | select(.type=="result")
      | .result // empty
      | @base64
    ' "$log_path" | tail -n 1
  )"

  if [ -n "$encoded_result" ]; then
    printf '%s\n' "$encoded_result" | jq -Rr '@base64d'
    return 0
  fi

  extract_text_result_from_log "$log_path"
}

extract_task_result_markdown() {
  local provider_name="$1"
  local log_path="$2"

  case "$provider_name" in
    codex)  extract_codex_result_markdown "$log_path" ;;
    gemini) extract_text_result_from_log "$log_path" ;;
    claude) extract_claude_result_markdown "$log_path" ;;
    *)      extract_text_result_from_log "$log_path" ;;
  esac
}

detect_codex_auth_error() {
  local log_path="$1"
  local error_code=""

  [ -f "$log_path" ] || return 1

  error_code="$(jq -Rr '
    fromjson?
    | select(.type == "error" or .type == "turn.failed")
    | (
        (.error.code // .code) as $code |
        ((.message // .error.message // "") |
          if test("Unauthorized|Invalid API key|Incorrect API key"; "i")
          then "auth_error"
          else null end) as $msg_code |
        ($code // $msg_code)
      )
    | select(. != null)
    | select(
        . == "refresh_token_reused" or
        . == "invalid_api_key" or
        . == "token_expired" or
        . == "auth_error" or
        startswith("auth_")
      )
  ' "$log_path" | head -1)"

  if [ -n "$error_code" ]; then
    printf '%s\n' "$error_code"
    return 0
  fi

  return 1
}

build_task_execute_url() {
  local task_id="$1"

  if [ -z "${task_execute_base_url:-}" ] || [ -z "${task_executor_token:-}" ]; then
    return 1
  fi

  printf '%s/%s/execute\n' "${task_execute_base_url%/}" "$task_id"
}

write_task_request_headers() {
  local task_claim_token="${1:-}"

  printf 'Authorization: Bearer %s\n' "$task_executor_token"
  if [ -n "$task_claim_token" ]; then
    printf 'X-Task-Claim-Token: %s\n' "$task_claim_token"
  fi
}

post_task_update_from_controller() {
  local task_id="$1"
  local task_claim_token="$2"
  local action="$3"
  local message="${4:-}"
  local url=""
  local payload=""
  local response_file=""
  local status=""
  local -a curl_args=()

  if ! url="$(build_task_execute_url "$task_id")"; then
    return 0
  fi

  case "$action" in
    progress)
      payload="$(jq -cn --arg action "progress" --arg progress "$message" '{action: $action, progress: $progress}')"
      ;;
    complete)
      payload="$(jq -cn --arg action "complete" --arg result "$message" '{action: $action, result: $result}')"
      ;;
    fail)
      payload="$(jq -cn --arg action "fail" --arg error "$message" '{action: $action, error: $error}')"
      ;;
    timeout)
      payload='{"action":"timeout"}'
      ;;
    heartbeat)
      payload='{"action":"heartbeat"}'
      ;;
    *)
      echo "Unsupported task action: ${action}" >&2
      return 1
      ;;
  esac

  response_file="$(mktemp)"
  curl_args=(
    -sS
    -o "$response_file"
    -w '%{http_code}'
    -X POST
    -H "Content-Type: application/json"
    -d "$payload"
    "$url"
  )
  status="$(write_task_request_headers "$task_claim_token" | curl "${curl_args[@]}" -H @-)"

  if [ "$status" != "200" ]; then
    log "Task update failed: task_id=${task_id} action=${action} status=${status}"
    sed 's/^/[task-update] /' "$response_file" >&2 || true
    rm -f "$response_file"
    return 1
  fi

  rm -f "$response_file"
  return 0
}

start_task_heartbeat_loop_from_controller() {
  local task_id="$1"
  local task_claim_token="$2"

  controller_trigger_background_pid=""

  if [ "$task_heartbeat_interval_seconds" -le 0 ]; then
    return 1
  fi

  (
    trap 'exit 0' TERM INT
    while true; do
      sleep "$task_heartbeat_interval_seconds" &
      wait $! || exit 0
      post_task_update_from_controller "$task_id" "$task_claim_token" heartbeat "" || true
    done
  ) >/dev/null 2>&1 &
  controller_trigger_background_pid="$!"
  return 0
}

stop_background_loop_pid() {
  local pid="${1:-}"

  if [ -z "$pid" ]; then
    return 0
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" 2>/dev/null || true
}

resolve_task_prompt_template() {
  local template_path=""

  template_path="${AGENT_TASK_PROMPT_FILE:-${HIVEMOOT_TASK_PLUGIN_DIR}/prompts/messages/task.md}"

  if [ ! -f "$template_path" ]; then
    echo "Task prompt template not found: ${template_path}" >&2
    return 1
  fi

  printf '%s\n' "$template_path"
}

build_task_extra_prompt() {
  local task_id="$1"
  local task_prompt="$2"
  local task_messages_file="${3:-}"
  local base_extra_prompt="${4:-}"
  local template_path=""
  local task_prompt_block=""
  local task_messages_block=""

  template_path="$(resolve_task_prompt_template)" || return 1
  task_prompt_block="$(cat "$template_path")"
  task_prompt_block="${task_prompt_block//\$\{task_id\}/$task_id}"
  task_prompt_block="${task_prompt_block//\$\{task_prompt\}/$task_prompt}"

  if [ -n "$task_messages_file" ]; then
    task_messages_block="$(render_task_messages_block "$task_messages_file")" || return 1
    if [ -n "$task_messages_block" ]; then
      task_prompt_block="${task_prompt_block}

${task_messages_block}"
    fi
  fi

  if [ -n "$base_extra_prompt" ]; then
    printf '%s\n\n%s\n' "$base_extra_prompt" "$task_prompt_block"
    return 0
  fi

  printf '%s\n' "$task_prompt_block"
}

controller_trigger_prepare_job__hivemoot_task() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local job_workspace="$4"
  local provider_name="$6"
  local task_id="$7"
  local task_prompt="$8"
  local task_claim_token="$9"
  local task_messages_json="${10:-}"
  local base_extra_prompt="${11:-}"
  local base_session_key="${12:-}"
  local task_messages_host_path=""
  local task_extra_prompt=""

  if [ -z "$task_id" ] || [ -z "$task_prompt" ]; then
    echo "Task jobs require task_id and task_prompt." >&2
    return 1
  fi

  if [ -n "$task_messages_json" ]; then
    task_messages_host_path="${job_workspace}/task-input/${task_id}/messages.json"
    mkdir -p "$(dirname "$task_messages_host_path")"
    printf '%s' "$task_messages_json" > "$task_messages_host_path"
    chmod 600 "$task_messages_host_path" 2>/dev/null || true
    if [[ "$(uname -s)" == "Linux" ]]; then
      chown -R 1000:1000 "${job_workspace}/task-input" 2>/dev/null || true
    fi
  fi

  if ! task_extra_prompt="$(build_task_extra_prompt "$task_id" "$task_prompt" "$task_messages_host_path" "$base_extra_prompt")"; then
    report_task_failure_from_controller "$task_id" "125" "Failed to build task prompt context" "$task_claim_token" || true
    return 1
  fi

  controller_trigger_prepared_memory_mode="ro"
  controller_trigger_prepared_extra_prompt="$task_extra_prompt"
  if [ -n "$base_session_key" ]; then
    controller_trigger_prepared_session_key="$base_session_key"
  else
    controller_trigger_prepared_session_key="task:${task_id}"
  fi

  if [ "$provider_name" = "codex" ]; then
    controller_trigger_prepared_codex_answer_host_path="${job_workspace}/task-output/${task_id}/codex-answer.md"
    controller_trigger_prepared_codex_answer_worker_path="/workspace/task-output/${task_id}/codex-answer.md"
  fi
}

controller_trigger_on_global_slot_wait_timeout__hivemoot_task() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local timeout_secs="$4"
  local task_id="$5"
  local task_claim_token="$6"

  if [ -n "$task_id" ]; then
    if report_task_failure_from_controller "$task_id" "124" "Timed out waiting ${timeout_secs}s for a global worker slot" "$task_claim_token"; then
      log "Task failure reported to backend: task_id=${task_id} exit_code=124"
    else
      log "Task failure report to backend failed (best-effort): task_id=${task_id} exit_code=124"
    fi
  fi
}

controller_trigger_on_spawn_failure__hivemoot_task() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local task_id="$4"
  local task_claim_token="$5"

  if [ -n "$task_id" ]; then
    report_task_failure_from_controller "$task_id" "125" "Failed to start worker container" "$task_claim_token" || true
  fi
}

controller_trigger_after_worker_start__hivemoot_task() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local task_id="$5"
  local task_claim_token="$6"

  if [ -z "$task_id" ]; then
    return 0
  fi

  post_task_update_from_controller "$task_id" "$task_claim_token" progress "Task ${task_id} claimed. Starting execution." || true
  if ! start_task_heartbeat_loop_from_controller "$task_id" "$task_claim_token"; then
    log "Task heartbeat loop not started: task_id=${task_id}"
  fi
}

extract_task_result_markdown_from_controller() {
  local provider_name="$1"
  local log_path="$2"
  local codex_answer_file="${3:-}"

  if [ "$provider_name" = "codex" ] && [ -n "$codex_answer_file" ]; then
    CODEX_ANSWER_FILE="$codex_answer_file" extract_task_result_markdown "$provider_name" "$log_path"
    return 0
  fi

  extract_task_result_markdown "$provider_name" "$log_path"
}

handle_task_job_result() {
  local task_id="$1"
  local repo="$2"
  local provider_name="$3"
  local exit_code="$4"
  local container_log_file="$5"
  local job_workspace="$6"
  local task_claim_token="${7:-}"
  local codex_answer_host_path="${8:-}"
  local max_result_bytes=100000
  local task_result_markdown=""
  local auth_error_code=""
  local complete_payload=""
  local result_payload=""
  local result_path="${job_workspace}/task-output/${task_id}/result.md"
  local classified_error=""

  if [ "$exit_code" -eq 0 ] && [ -f "$container_log_file" ]; then
    task_result_markdown="$(extract_task_result_markdown_from_controller "$provider_name" "$container_log_file" "$codex_answer_host_path")"
  fi

  if [ "$exit_code" -eq 0 ] && [ "$provider_name" = "codex" ] && [ -z "$task_result_markdown" ] && [ -f "$container_log_file" ]; then
    if auth_error_code="$(detect_codex_auth_error "$container_log_file")"; then
      log "Codex auth error detected in task output: ${auth_error_code}; promoting to failure"
      exit_code=1
    fi
  fi

  if [ "$exit_code" -eq 0 ]; then
    if [ -n "$task_result_markdown" ]; then
      complete_payload="$task_result_markdown"
    elif [ "$provider_name" = "codex" ]; then
      complete_payload="Task completed, but no agent markdown result could be extracted from Codex JSON logs. See local debug details in task-output/${task_id}/result.md."
    elif [ "$provider_name" = "gemini" ] || [ "$provider_name" = "claude" ]; then
      complete_payload="Task completed, but no output was captured from ${provider_name}. See local debug details in task-output/${task_id}/result.md."
    fi
  fi

  mkdir -p "$(dirname "$result_path")"
  {
    if [ -n "$task_result_markdown" ]; then
      printf '%s\n' "$task_result_markdown"
      echo
    fi
    echo "# Task Result"
    echo
    echo "- task_id: ${task_id}"
    echo "- repo: ${repo}"
    echo "- provider: ${provider_name}"
    echo "- exit_code: ${exit_code}"
    if [ "$exit_code" -eq 0 ] && [ -z "$task_result_markdown" ] && [ "$provider_name" = "codex" ]; then
      echo
      echo "Execution finished, but the markdown result could not be extracted from Codex logs."
    elif [ "$exit_code" -eq 0 ] && [ -z "$task_result_markdown" ] && { [ "$provider_name" = "gemini" ] || [ "$provider_name" = "claude" ]; }; then
      echo
      echo "Execution finished, but no output was captured from ${provider_name}."
    elif [ "$exit_code" -eq 0 ]; then
      echo
      echo "Execution finished successfully."
    elif [ "$exit_code" -eq 124 ]; then
      echo
      echo "Execution timed out."
    elif [ -n "$auth_error_code" ]; then
      echo
      echo "Provider authentication failed: ${auth_error_code}"
    else
      echo
      echo "Execution failed."
    fi
    if [ -f "$container_log_file" ]; then
      echo
      echo "## Debug Log Tail"
      echo
      echo '```text'
      tail -n 200 "$container_log_file"
      echo '```'
    fi
  } > "$result_path"

  result_payload="${complete_payload:-$(cat "$result_path")}"
  if [ "$(printf '%s' "$result_payload" | wc -c | tr -d ' ')" -gt "$max_result_bytes" ]; then
    result_payload="$(printf '%s' "$result_payload" | head -c "$max_result_bytes")

[truncated: exceeded ${max_result_bytes} bytes]"
  fi

  if [ "$exit_code" -eq 0 ]; then
    post_task_update_from_controller "$task_id" "$task_claim_token" complete "$result_payload" || true
  elif [ "$exit_code" -eq 124 ]; then
    post_task_update_from_controller "$task_id" "$task_claim_token" timeout "" || true
  elif [ -n "$auth_error_code" ]; then
    post_task_update_from_controller "$task_id" "$task_claim_token" fail "Provider authentication failed: ${auth_error_code}" || true
  else
    classified_error="$(classify_worker_log_failure "$container_log_file" 2>/dev/null || true)"
    report_task_failure_from_controller "$task_id" "$exit_code" "$classified_error" "$task_claim_token" || true
  fi

  return "$exit_code"
}

controller_trigger_on_worker_exit__hivemoot_task() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local provider_name="$4"
  local exit_code="$5"
  local container_log_file="$6"
  local job_workspace="$7"
  local task_id="$8"
  local task_claim_token="$9"
  local codex_answer_host_path="${10:-}"
  local final_exit_code=0

  if [ -z "$task_id" ]; then
    printf '%s\n' "$exit_code"
    return 0
  fi

  if handle_task_job_result "$task_id" "$repo" "$provider_name" "$exit_code" "$container_log_file" "$job_workspace" "$task_claim_token" "$codex_answer_host_path"; then
    final_exit_code=0
  else
    final_exit_code=$?
  fi

  printf '%s\n' "$final_exit_code"
}

report_task_failure_from_controller() {
  local task_id="$1"
  local exit_code="$2"
  local classified_error="${3:-}"
  local task_claim_token="${4:-}"
  local error_msg=""

  if [ -n "$classified_error" ]; then
    error_msg="${classified_error} (exit code ${exit_code})"
  else
    error_msg="Worker exited with code ${exit_code}"
  fi

  post_task_update_from_controller "$task_id" "$task_claim_token" fail "$error_msg"
}

pick_next_task_agent() {
  local agent_id=""

  agent_id="${task_agent_ids[$next_task_agent_index]}"
  next_task_agent_index=$((next_task_agent_index + 1))
  if [ "$next_task_agent_index" -ge "$task_agent_count" ]; then
    next_task_agent_index=0
  fi

  printf '%s\n' "$agent_id"
}

load_task_dispatch_agent_scope() {
  local raw_ids="$1"
  local entry=""
  local trimmed_entry=""
  local -a parsed_entries=()
  local -A seen_dispatch_agents=()

  if [ -z "$raw_ids" ]; then
    echo "TASK_DISPATCH_AGENT_IDS is required when WATCH_TASKS=1." >&2
    exit 1
  fi

  IFS=',' read -r -a parsed_entries <<< "$raw_ids"
  for entry in "${parsed_entries[@]}"; do
    trimmed_entry="$(trim "$entry")"
    if [ -z "$trimmed_entry" ]; then
      echo "TASK_DISPATCH_AGENT_IDS contains an empty entry." >&2
      exit 1
    fi

    validate_agent_id "$trimmed_entry"
    if [ -z "${agent_token_files[$trimmed_entry]:-}" ]; then
      echo "TASK_DISPATCH_AGENT_IDS includes unknown agent id: ${trimmed_entry}" >&2
      exit 1
    fi
    if [ -n "${seen_dispatch_agents[$trimmed_entry]:-}" ]; then
      echo "TASK_DISPATCH_AGENT_IDS contains duplicate agent id: ${trimmed_entry}" >&2
      exit 1
    fi

    seen_dispatch_agents["$trimmed_entry"]=1
    task_agent_ids+=("$trimmed_entry")
  done

  if [ "${#task_agent_ids[@]}" -eq 0 ]; then
    echo "TASK_DISPATCH_AGENT_IDS must include at least one agent id." >&2
    exit 1
  fi

  task_agent_count="${#task_agent_ids[@]}"
}

claim_next_task() {
  local response_file=""
  local status=""
  local repos_count=""

  claimed_task_id=""
  claimed_task_prompt=""
  claimed_task_repo=""
  claimed_task_claim_token=""
  claimed_task_messages_json=""

  response_file="$(mktemp)"
  status="$(write_task_request_headers | curl -sS -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -H @- \
    "$task_claim_url")"

  if [ "$status" = "204" ]; then
    rm -f "$response_file"
    return 1
  fi

  if [ "$status" != "200" ]; then
    log "Task claim failed with status ${status}"
    sed 's/^/[task-claim] /' "$response_file" >&2 || true
    rm -f "$response_file"
    return 2
  fi

  claimed_task_id="$(jq -r '.task.task_id // empty' < "$response_file")"
  claimed_task_prompt="$(jq -r '.task.prompt // empty' < "$response_file")"
  claimed_task_claim_token="$(jq -r '.claim_token // empty' < "$response_file")"
  if ! claimed_task_messages_json="$(jq -c '(.messages // []) | if type=="array" then . else [] end' < "$response_file")"; then
    log "Claimed task response contains invalid messages payload"
    rm -f "$response_file"
    return 2
  fi
  repos_count="$(jq -r '(.task.repos | length) // 0' < "$response_file")"
  if [ "$repos_count" -ne 1 ]; then
    log "Claimed task must contain exactly one repo, got ${repos_count}"
    rm -f "$response_file"
    return 2
  fi
  claimed_task_repo="$(jq -r '.task.repos[0] // empty' < "$response_file")"

  rm -f "$response_file"

  if [ -z "$claimed_task_id" ] || [ -z "$claimed_task_prompt" ] || [ -z "$claimed_task_repo" ] || [ -z "$claimed_task_claim_token" ]; then
    log "Claimed task missing required fields (task_id/prompt/repo/claim_token)"
    return 2
  fi
  if ! task_id_is_valid "$claimed_task_id"; then
    log "Claimed task_id has invalid format: ${claimed_task_id}"
    return 2
  fi
  if ! repo_name_is_valid "$claimed_task_repo"; then
    log "Claimed task repo has invalid format: ${claimed_task_repo}"
    return 2
  fi

  return 0
}

queue_claimed_task_job() {
  local agent_id=""
  local job_id=""
  local task_session_key=""

  if [ -z "$claimed_task_id" ] || [ -z "$claimed_task_prompt" ] || [ -z "$claimed_task_repo" ] || [ -z "$claimed_task_claim_token" ]; then
    return 1
  fi

  agent_id="$(pick_next_task_agent)"
  job_id="$(generate_job_id)"
  task_session_key="task:${claimed_task_id}"

  if launch_job "$job_id" "$claimed_task_repo" "$agent_id" "hivemoot-task" "$global_extra_prompt" "" "" "$task_session_key" "" "$claimed_task_id" "$claimed_task_prompt" "$claimed_task_claim_token" "$claimed_task_messages_json"; then
    log "Queued claimed task: task_id=${claimed_task_id} repo=${claimed_task_repo} agent=${agent_id} job=${job_id}"
    return 0
  fi

  log "Failed to queue claimed task: task_id=${claimed_task_id} repo=${claimed_task_repo}"
  return 1
}

queue_claimed_tasks_once() {
  local claim_status=0

  while [ "${#running_pids[@]}" -lt "$controller_max_workers" ]; do
    claim_status=0
    claim_next_task || claim_status=$?
    if [ "$claim_status" -eq 0 ]; then
      if ! queue_claimed_task_job; then
        if [ "$shutdown_requested" -eq 0 ]; then
          failed_jobs=$((failed_jobs + 1))
        fi
        return 1
      fi
      continue
    fi

    if [ "$claim_status" -eq 1 ]; then
      log "No pending task available"
      return 0
    fi

    failed_jobs=$((failed_jobs + 1))
    return 1
  done

  return 0
}

run_task_watch_loop() {
  local claim_status=0
  local queued_any=0

  log "Task watching enabled (poll interval: ${task_poll_interval_secs}s)"

  while [ "$shutdown_requested" -eq 0 ]; do
    reap_finished_jobs
    queued_any=0

    while [ "$shutdown_requested" -eq 0 ] && [ "${#running_pids[@]}" -lt "$controller_max_workers" ]; do
      claim_status=0
      claim_next_task || claim_status=$?
      if [ "$claim_status" -eq 0 ]; then
        if queue_claimed_task_job; then
          queued_any=1
          continue
        fi

        if [ "$shutdown_requested" -eq 0 ]; then
          failed_jobs=$((failed_jobs + 1))
        fi
        break
      fi

      if [ "$claim_status" -eq 1 ]; then
        break
      fi
      sleep "$task_poll_interval_secs" &
      wait $! || true
      continue
    done

    if [ "$shutdown_requested" -ne 0 ]; then
      break
    fi

    if [ "$queued_any" -eq 0 ]; then
      sleep "$task_poll_interval_secs" &
      wait $! || true
    fi
  done
}
