#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_CORE_JOBS_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_CORE_JOBS_LOADED=1

spawn_worker() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local job_workspace="$4"
  local job_home="$5"
  local token_file="$6"
  local extra_prompt="$7"
  local session_key="$8"
  local trigger_type="$9"
  local task_id="${10:-}"
  local codex_answer_file="${11:-}"

  local container_name="${worker_name_prefix}-${job_id}"
  local prompt_file="${AGENT_PROMPT_FILE:-}"
  local companion_base_prompt=""
  local job_agent_skills=""
  local worker_trigger=""
  local worker_plugins=""
  local worker_github_repos=""
  local worker_driver="once"
  local health_kind=""
  local extra_prompt_host_path=""
  local extra_prompt_worker_path=""
  local controller_agent_identity="${AGENT_IDENTITY:-hivemoot-agent}"

  worker_trigger="$(normalize_trigger_name "$trigger_type")"
  health_kind="$(controller_invoke_trigger_hook health_kind "$worker_trigger")"
  job_agent_skills="$(resolve_agent_skill_list "$agent_id")"

  docker_run_args=(
    run
    -d
    --name "${container_name}"
    --label "hivemoot.controller=true"
    --label "hivemoot.controller.instance=${controller_instance_id}"
    --label "hivemoot.job_id=${job_id}"
    --label "hivemoot.repo=${repo}"
    --cap-drop=ALL
    --security-opt=no-new-privileges
    --read-only
    --tmpfs "/tmp:size=2g,mode=1777"
    --memory "${AGENT_MEMORY_LIMIT:-16g}"
    --cpus "${AGENT_CPU_LIMIT:-2.0}"
    --pids-limit "${AGENT_PIDS_LIMIT:-512}"
    -v "${job_workspace}:/workspace"
    -v "${job_home}:/home/node"
    -v "${token_file}:/run/secrets/agent_token:ro"
  )

  # Tag messaging containers so injection logic can find them by session key.
  # Scoped to messaging triggers to avoid labeling mention/task containers.
  if [ -n "$session_key" ] && [ "$worker_trigger" = "messaging" ]; then
    docker_run_args+=( --label "hivemoot.messaging.session_key=${session_key}" )
  fi

  # Mount persistent session-map directory when the trigger provides one.
  if [ -n "${controller_trigger_prepared_persistent_session_dir:-}" ]; then
    docker_run_args+=(
      -v "${controller_trigger_prepared_persistent_session_dir}:/workspace/persistent-sessions"
    )
  fi

  # Mount persistent agent memory directory.
  # AGENT_MEMORY_MODE controls prompt injection (rw/ro/none), not filesystem access.
  local memory_mode="${controller_trigger_prepared_memory_mode:-rw}"
  local memory_host_dir=""
  if [ -n "${controller_trigger_prepared_memory_host_dir:-}" ]; then
    memory_host_dir="$controller_trigger_prepared_memory_host_dir"
  else
    local memory_safe_repo
    memory_safe_repo="$(printf '%s' "$repo" | tr -c 'A-Za-z0-9._-' '_')"
    memory_host_dir="${memory_root}/${memory_safe_repo}/${agent_id}"
  fi
  mkdir -p "$memory_host_dir"
  chmod 700 "$memory_host_dir" 2>/dev/null || true
  if [[ "$(uname -s)" == "Linux" ]]; then
    chown -R 1000:1000 "$memory_host_dir" 2>/dev/null || true
  fi
  docker_run_args+=(
    -v "${memory_host_dir}:/home/node/.hivemoot/memory"
    -e "AGENT_MEMORY_DIR=/home/node/.hivemoot/memory"
    -e "AGENT_MEMORY_MODE=${memory_mode}"
  )

  local codex_auth_file="${CODEX_AUTH_FILE:-}"
  if [ -n "$codex_auth_file" ] && [ -f "$codex_auth_file" ]; then
    mkdir -p "${job_home}/.codex"
    cp "$codex_auth_file" "${job_home}/.codex/auth.json"
    chmod 600 "${job_home}/.codex/auth.json"
    if [[ "$(uname -s)" == "Linux" ]]; then
      chown -R 1000:1000 "${job_home}/.codex" 2>/dev/null || true
    fi
  fi

  local gemini_auth_dir="${GEMINI_AUTH_DIR:-}"
  if [ -n "$gemini_auth_dir" ] && [ -d "$gemini_auth_dir" ]; then
    mkdir -p "${job_home}/.gemini"
    local f=""
    for f in oauth_creds.json google_accounts.json settings.json; do
      if [ -f "${gemini_auth_dir}/${f}" ]; then
        cp "${gemini_auth_dir}/${f}" "${job_home}/.gemini/${f}"
        chmod 600 "${job_home}/.gemini/${f}"
      fi
    done
    if [[ "$(uname -s)" == "Linux" ]]; then
      chown -R 1000:1000 "${job_home}/.gemini" 2>/dev/null || true
    fi
  fi

  docker_run_args+=(
    -e "AGENT_DRIVER=${worker_driver}"
    -e TARGET_REPO="${repo}"
    -e WORKSPACE_ROOT=/workspace
    -e JOB_ID="${job_id}"
    -e AGENT_ID="${agent_id}"
    -e AGENT_TOKEN_FILE=/run/secrets/agent_token
    -e HIVEMOOT_CLI_UPDATE=skip
    -e RUN_TRIGGER_TYPE="${health_kind}"
  )

  worker_plugins="$(controller_invoke_trigger_hook worker_plugins "$worker_trigger")"
  worker_github_repos="${GITHUB_REPOS:-${repo}}"
  docker_run_args+=( -e "AGENT_PLUGINS=${worker_plugins}" )
  docker_run_args+=( -e "GITHUB_REPOS=${worker_github_repos}" )

  if [ -n "$extra_prompt" ]; then
    extra_prompt_host_path="${job_workspace}/job-input/extra-prompt.md"
    extra_prompt_worker_path="/workspace/job-input/extra-prompt.md"
    mkdir -p "$(dirname "$extra_prompt_host_path")"
    printf '%s' "$extra_prompt" > "$extra_prompt_host_path"
    chmod 600 "$extra_prompt_host_path" 2>/dev/null || true
    if [[ "$(uname -s)" == "Linux" ]]; then
      chown -R 1000:1000 "${job_workspace}/job-input" 2>/dev/null || true
    fi
    docker_run_args+=( -e "AGENT_EXTRA_PROMPT_FILE=${extra_prompt_worker_path}" )
  fi
  if [ -n "$session_key" ]; then
    docker_run_args+=( -e "AGENT_SESSION_KEY=${session_key}" )
  fi
  if [ -n "${controller_trigger_prepared_persistent_session_dir:-}" ]; then
    docker_run_args+=( -e "PERSISTENT_SESSION_DIR=/workspace/persistent-sessions" )
  fi
  # Messaging jobs use the persistent HOME mounted at /home/node.  Setting
  # REPO_DIR/LOG_DIR enables managed mode in run-once.sh, which skips
  # per-job HOME creation and keeps HOME=/home/node.
  if [ -n "${controller_trigger_prepared_job_home:-}" ]; then
    docker_run_args+=( -e "REPO_DIR=/workspace/repo" )
    docker_run_args+=( -e "LOG_DIR=/workspace/runs" )
  fi
  if [ -n "$task_id" ]; then
    docker_run_args+=( -e "AGENT_TASK_ID=${task_id}" )
  fi
  if [ -n "$codex_answer_file" ]; then
    docker_run_args+=( -e "CODEX_ANSWER_FILE=${codex_answer_file}" )
  fi

  docker_run_args+=( -e "AGENT_IDENTITY=${controller_agent_identity}" )
  append_env_if_set AGENT_PROVIDER
  append_env_if_set AGENT_AUTH_MODE
  append_env_if_set AGENT_MODEL
  append_env_if_set AGENT_PROMPT_FILE
  if [ -n "$job_agent_skills" ]; then
    docker_run_args+=( -e "AGENT_SKILLS=${job_agent_skills}" )
  fi
  append_env_if_set AGENT_AVAILABLE_SKILLS
  append_env_if_set AGENT_TIMEOUT_SECONDS
  append_env_if_set AGENT_TOOL_OPTIONS_JSON
  append_env_if_set GIT_CLONE_DEPTH
  append_env_if_set GITHUB_CLONE_DEPTH
  append_env_if_set GITHUB_WORKSPACE
  append_env_if_set GITHUB_GIT_NAME
  append_env_if_set GITHUB_GIT_EMAIL
  append_env_if_set HIVEMOOT_BUZZ_ROLE
  append_env_if_set SHARED_CLONE_CACHE
  append_env_if_set SESSION_RESUME
  append_env_if_set SESSION_RESUME_MAX_IDLE_HOURS
  append_env_if_set SESSION_RESUME_MAX_AGE_HOURS
  append_env_if_set SESSION_RESET_AT_HOUR
  append_env_if_set KILO_PROVIDER
  append_env_if_set KILO_MODEL
  append_env_if_set OPENCODE_PROVIDER
  append_env_if_set OPENCODE_MODEL
  append_env_if_set HEALTH_REPORT_URL
  append_env_if_set HEALTH_REPORT_TIMEOUT_SECS
  append_env_if_set HEALTH_REPORT_MAX_RETRIES
  append_env_if_set HEALTH_REPORT_RUN_SUMMARY
  append_env_if_set MESSAGING_PLATFORM
  append_env_if_set MESSAGING_AGENT_ID
  append_env_if_set MESSAGING_ALLOWED_CHAT_IDS

  append_secret_env HIVEMOOT_AGENT_TOKEN
  append_secret_env OPENAI_API_KEY
  append_secret_env GOOGLE_API_KEY
  append_secret_env GEMINI_API_KEY
  append_secret_env ANTHROPIC_API_KEY
  append_secret_env OPENROUTER_API_KEY
  append_secret_env CLAUDE_CODE_OAUTH_TOKEN
  append_secret_env TELEGRAM_BOT_TOKEN
  append_secret_env KILOCODE_TOKEN
  append_secret_env ZAI_API_KEY

  if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
    case "$prompt_file" in
      /*) ;;
      *)
        echo "AGENT_PROMPT_FILE must be an absolute path when mounting custom prompts." >&2
        return 1
        ;;
    esac
    if companion_base_prompt="$(resolve_companion_base_prompt "$prompt_file")"; then
      docker_run_args+=( -v "${companion_base_prompt}:${companion_base_prompt}:ro" )
    fi
    docker_run_args+=( -v "${prompt_file}:${prompt_file}:ro" )
  fi

  if ! append_bind_mount_specs AGENT_SKILL_BIND_MOUNTS; then
    return 1
  fi

  docker_run_args+=( "$worker_image" )
  "$docker_cmd" "${docker_run_args[@]}"
}

container_oom_exit_code() {
  local container_id="$1"
  local inspect_output=""
  local oom_flag=""
  local inspected_exit_code=""

  if ! inspect_output="$("$docker_cmd" inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' "$container_id" 2>/dev/null | tail -n 1)"; then
    return 1
  fi

  oom_flag="$(printf '%s' "$inspect_output" | awk '{print $1}')"
  inspected_exit_code="$(printf '%s' "$inspect_output" | awk '{print $2}')"

  if [ "$oom_flag" != "true" ]; then
    return 1
  fi

  case "$inspected_exit_code" in
    ''|*[!0-9]*)
      printf '137\n'
      ;;
    *)
      printf '%s\n' "$inspected_exit_code"
      ;;
  esac
}

stop_controller_workers() {
  local -a container_ids=()

  if ! mapfile -t container_ids < <("$docker_cmd" ps -q --filter "label=hivemoot.controller.instance=${controller_instance_id}" 2>/dev/null); then
    return 0
  fi

  if [ "${#container_ids[@]}" -eq 0 ]; then
    return 0
  fi

  log "Stopping ${#container_ids[@]} running worker container(s)"
  "$docker_cmd" stop --time "$shutdown_grace_secs" "${container_ids[@]}" >/dev/null 2>&1 || true
}

stop_job_subshells() {
  local pid=""
  local job_exit=0

  if [ "${#running_pids[@]}" -gt 0 ]; then
    log "Stopping ${#running_pids[@]} tracked job subshell(s)"
  fi

  for pid in "${running_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for pid in "${running_pids[@]}"; do
    if wait "$pid" 2>/dev/null; then
      job_exit=0
    else
      job_exit=$?
    fi
    record_job_completion "$pid" "$job_exit"
  done

  running_pids=()
}

record_job_completion() {
  local pid="$1"
  local exit_code="$2"
  local job_id="${pid_to_job_id[$pid]:-unknown}"
  local repo="${pid_to_repo[$pid]:-unknown}"
  local agent_id="${pid_to_agent[$pid]:-unknown}"
  local trigger_type="${pid_to_trigger_type[$pid]:-periodic}"
  local ack_key="${pid_to_ack_key[$pid]:-}"
  local state_file="${pid_to_state_file[$pid]:-}"
  local processing_file="${pid_to_processing_file[$pid]:-}"
  local global_slot_timeout_file="${jobs_root}/${job_id}/global-slot-timeout"
  local global_slot_timeout_secs=""
  local hook_status=0

  unset \
    "pid_to_job_id[$pid]" \
    "pid_to_repo[$pid]" \
    "pid_to_agent[$pid]" \
    "pid_to_trigger_type[$pid]" \
    "pid_to_ack_key[$pid]" \
    "pid_to_state_file[$pid]" \
    "pid_to_processing_file[$pid]"

  if [ -f "$global_slot_timeout_file" ]; then
    global_slot_timeout_secs="$(read_global_slot_timeout_secs "$global_slot_timeout_file")"
    [ -n "$global_slot_timeout_secs" ] || global_slot_timeout_secs="unknown"
    controller_invoke_trigger_hook on_global_slot_timeout "$trigger_type" "$processing_file" "$job_id" "$repo" "$agent_id" "$global_slot_timeout_secs"
    rm -f "$global_slot_timeout_file" 2>/dev/null || true
    return 0
  fi

  if [ "$exit_code" -eq 0 ]; then
    hook_status=0
    controller_invoke_trigger_hook on_success "$trigger_type" "$processing_file" "$job_id" "$repo" "$agent_id" "$ack_key" "$state_file" || hook_status=$?
    if [ "$hook_status" -eq 0 ]; then
      completed_jobs=$((completed_jobs + 1))
      log "Job completed: id=${job_id} repo=${repo} agent=${agent_id}"
    else
      failed_jobs=$((failed_jobs + 1))
      log "Job failed: id=${job_id} repo=${repo} agent=${agent_id} ack_failed=1"
    fi
    return 0
  fi

  hook_status=0
  controller_invoke_trigger_hook on_failure "$trigger_type" "$processing_file" "$job_id" "$repo" "$agent_id" "$exit_code" "$ack_key" "$state_file" || hook_status=$?
  if [ "$hook_status" -ne 0 ]; then
    log "WARN: trigger failure hook failed: trigger=${trigger_type} job=${job_id} repo=${repo} agent=${agent_id} exit=${exit_code} hook_exit=${hook_status}"
  fi
  if [ -n "$processing_file" ] && [ -f "$processing_file" ]; then
    if ! mv -f "$processing_file" "${processing_file%.processing}.failed" 2>/dev/null; then
      log "WARN: failed to finalize failed trigger: file=${processing_file}"
    fi
  fi
  failed_jobs=$((failed_jobs + 1))
  log "Job failed: id=${job_id} repo=${repo} agent=${agent_id} exit=${exit_code}"
}

reap_finished_jobs() {
  local pid=""
  local job_exit=0
  local -a still_running=()

  for pid in "${running_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      still_running+=("$pid")
      continue
    fi

    if wait "$pid" 2>/dev/null; then
      job_exit=0
    else
      job_exit=$?
    fi

    record_job_completion "$pid" "$job_exit"
  done

  running_pids=("${still_running[@]}")
}

wait_for_available_slot() {
  while true; do
    if [ "$shutdown_requested" -ne 0 ]; then
      return 1
    fi

    reap_finished_jobs

    if [ "${#running_pids[@]}" -lt "$controller_max_workers" ]; then
      return 0
    fi

    sleep 1
  done
}

wait_for_all_jobs() {
  while [ "${#running_pids[@]}" -gt 0 ]; do
    reap_finished_jobs
    if [ "${#running_pids[@]}" -gt 0 ]; then
      sleep 1
    fi
  done
}

run_job() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local trigger_type="$4"
  local extra_prompt="$5"
  local session_key="$6"
  local task_id="${7:-}"
  local task_prompt="${8:-}"
  local task_claim_token="${9:-}"
  local task_messages_json="${10:-}"
  trigger_type="$(normalize_trigger_name "$trigger_type")"

  local token_file="${agent_token_files[$agent_id]}"
  local lock_key="${repo}:${agent_id}"
  local repo_lock_file="${repo_lock_files[$lock_key]:-}"
  local job_workspace="${workspaces_root}/${job_id}"
  local job_home="${homes_root}/${job_id}"
  local job_run_dir="${runs_root}/${job_id}"
  local job_spec_dir="${jobs_root}/${job_id}"
  local job_spec_file="${job_spec_dir}/job.json"
  local container_id=""
  local container_log_file="${job_run_dir}/container.log"
  local wait_output=""
  local wait_status=0
  local exit_code=125
  local log_pid=0
  local log_follow_deadline=0
  local provider_name="${AGENT_PROVIDER:-claude}"
  local global_slot_timeout_secs=0
  local trigger_exit_output=""
  local oom_exit_code=""
  local repo_lock_fd=""

  controller_reset_trigger_job_context
  trap 'stop_background_loop_pid "${controller_trigger_background_pid:-}"' EXIT

  if [ -z "$repo_lock_file" ]; then
    ensure_agent_lock_file "$repo" "$agent_id"
    repo_lock_file="${repo_lock_files[$lock_key]}"
  fi

  mkdir -p "$job_workspace" "$job_run_dir" "$job_spec_dir"
  chmod 700 "$job_workspace" "$job_run_dir" "$job_spec_dir" 2>/dev/null || true

  write_job_spec "$job_spec_file" "$job_id" "$repo" "$agent_id" "$trigger_type" "$agent_timeout_seconds"
  write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "queued" "-"

  if ! controller_invoke_trigger_hook prepare_job "$trigger_type" "$job_id" "$repo" "$agent_id" "$job_workspace" "$job_home" "$provider_name" "$task_id" "$task_prompt" "$task_claim_token" "$task_messages_json" "$extra_prompt" "$session_key"; then
    if [ "${controller_trigger_prepared_skip_credential_cleanup:-0}" -ne 1 ]; then
      cleanup_job_home_credentials "$job_home"
    fi
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "125"
    return 125
  fi

  if [ -n "$controller_trigger_prepared_extra_prompt" ]; then
    extra_prompt="$controller_trigger_prepared_extra_prompt"
  fi
  if [ -n "$controller_trigger_prepared_session_key" ]; then
    session_key="$controller_trigger_prepared_session_key"
  fi
  if [ -n "$controller_trigger_prepared_job_home" ]; then
    job_home="$controller_trigger_prepared_job_home"
  fi

  # Create job_home after prepare_job has had a chance to override it
  # (e.g. messaging trigger sets a persistent home).  Creating it before
  # the hook would leave an orphaned transient directory.
  mkdir -p "$job_home"
  chmod 700 "$job_home" 2>/dev/null || true
  if [[ "$(uname -s)" == "Linux" ]]; then
    chown 1000:1000 "$job_workspace" "$job_home" 2>/dev/null || true
  fi

  global_slot_timeout_secs="$(global_slot_timeout_for_trigger "$trigger_type")"
  if ! acquire_global_slot "$global_slot_timeout_secs"; then
    mark_global_slot_timeout "$job_spec_dir" "$global_slot_timeout_secs"
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "$global_slot_timeout_exit_code"
    controller_invoke_trigger_hook on_global_slot_wait_timeout "$trigger_type" "$job_id" "$repo" "$agent_id" "$global_slot_timeout_secs" "$task_id" "$task_claim_token" || true
    return "$global_slot_timeout_exit_code"
  fi

  exec {repo_lock_fd}>>"$repo_lock_file"
  flock "$repo_lock_fd"

  if [ "$shutdown_requested" -ne 0 ] || [ -f "$shutdown_flag_file" ]; then
    log "Skipping queued job due to shutdown: id=${job_id} repo=${repo} agent=${agent_id}"
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "cancelled" "-"
    close_slot_fd "$repo_lock_fd"
    repo_lock_fd=""
    release_global_slot
    return 0
  fi

  write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "running" "-"

  if ! container_id="$(spawn_worker "$job_id" "$repo" "$agent_id" "$job_workspace" "$job_home" "$token_file" "$extra_prompt" "$session_key" "$trigger_type" "$task_id" "$controller_trigger_prepared_codex_answer_worker_path")"; then
    if [ "${controller_trigger_prepared_skip_credential_cleanup:-0}" -ne 1 ]; then
      cleanup_job_home_credentials "$job_home"
    fi
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "125"
    controller_invoke_trigger_hook on_spawn_failure "$trigger_type" "$job_id" "$repo" "$agent_id" "$task_id" "$task_claim_token" || true
    close_slot_fd "$repo_lock_fd"
    repo_lock_fd=""
    release_global_slot
    return 125
  fi

  printf '%s\n' "$container_id" > "${job_run_dir}/container.id"
  log "Spawned worker: job=${job_id} container=${container_id} repo=${repo} agent=${agent_id}"

  controller_invoke_trigger_hook after_worker_start "$trigger_type" "$job_id" "$repo" "$agent_id" "$container_id" "$task_id" "$task_claim_token" || true

  "$docker_cmd" logs -f "$container_id" > "$container_log_file" 2>&1 &
  log_pid=$!

  if wait_output="$("$docker_cmd" wait "$container_id" 2>&1)"; then
    wait_status=0
  else
    wait_status=$?
  fi

  if [ "$log_pid" -gt 0 ]; then
    log_follow_deadline=$((SECONDS + 2))
    while kill -0 "$log_pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$log_follow_deadline" ]; then
        kill "$log_pid" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done
    wait "$log_pid" 2>/dev/null || true
  fi

  stop_background_loop_pid "$controller_trigger_background_pid"
  controller_trigger_background_pid=""

  if [ "$wait_status" -ne 0 ]; then
    printf '%s\n' "$wait_output" > "${job_run_dir}/docker-wait-error.log"
    exit_code=125
  else
    exit_code="$(printf '%s\n' "$wait_output" | tail -n 1 | tr -d '\r')"
    case "$exit_code" in
      ''|*[!0-9]*)
        printf '%s\n' "$wait_output" > "${job_run_dir}/docker-wait-error.log"
        exit_code=125
        ;;
    esac
  fi

  if oom_exit_code="$(container_oom_exit_code "$container_id")"; then
    log "Worker container was OOM-killed: container=${container_id} exit=${oom_exit_code}"
    exit_code="$oom_exit_code"
  fi

  if ! trigger_exit_output="$(controller_invoke_trigger_hook on_worker_exit "$trigger_type" "$job_id" "$repo" "$agent_id" "$provider_name" "$exit_code" "$container_log_file" "$job_workspace" "$task_id" "$task_claim_token" "$controller_trigger_prepared_codex_answer_host_path")"; then
    exit_code=$?
  elif [ -n "$trigger_exit_output" ]; then
    exit_code="$trigger_exit_output"
  fi

  "$docker_cmd" rm -f "$container_id" >/dev/null 2>&1 || true
  if [ "${controller_trigger_prepared_skip_credential_cleanup:-0}" -ne 1 ]; then
    cleanup_job_home_credentials "$job_home"
  fi
  close_slot_fd "$repo_lock_fd"
  repo_lock_fd=""
  release_global_slot

  if [ "$exit_code" -eq 0 ]; then
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "completed" "$exit_code"
  else
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "$exit_code"
  fi

  return "$exit_code"
}

launch_job() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local trigger_type="$4"
  local extra_prompt="$5"
  local ack_key="${6:-}"
  local state_file="${7:-}"
  local session_key="${8:-}"
  local processing_file="${9:-}"
  local task_id="${10:-}"
  local task_prompt="${11:-}"
  local task_claim_token="${12:-}"
  local task_messages_json="${13:-}"
  trigger_type="$(normalize_trigger_name "$trigger_type")"

  ensure_agent_lock_file "$repo" "$agent_id"

  if [ "$controller_max_workers" -gt 1 ]; then
    reap_finished_jobs
    local running_pid=""
    for running_pid in "${running_pids[@]}"; do
      if [ "${pid_to_agent[$running_pid]:-}" = "$agent_id" ]; then
        log "Agent ${agent_id} already running (job=${pid_to_job_id[$running_pid]}); deferring ${trigger_type} trigger"
        controller_invoke_trigger_hook on_duplicate_agent "$trigger_type" "$processing_file" "$job_id" "$repo" "$agent_id" || true
        return 0
      fi
    done
  fi

  if ! wait_for_available_slot; then
    return 1
  fi

  (
    run_job "$job_id" "$repo" "$agent_id" "$trigger_type" "$extra_prompt" "$session_key" "$task_id" "$task_prompt" "$task_claim_token" "$task_messages_json"
  ) &

  local pid=$!
  running_pids+=("$pid")
  pid_to_job_id["$pid"]="$job_id"
  pid_to_repo["$pid"]="$repo"
  pid_to_agent["$pid"]="$agent_id"
  pid_to_trigger_type["$pid"]="$trigger_type"
  pid_to_ack_key["$pid"]="$ack_key"
  pid_to_state_file["$pid"]="$state_file"
  pid_to_processing_file["$pid"]="$processing_file"

  log "Queued job: id=${job_id} repo=${repo} agent=${agent_id} trigger=${trigger_type}"
}
