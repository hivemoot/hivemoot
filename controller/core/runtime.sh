#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_CORE_RUNTIME_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_CORE_RUNTIME_LOADED=1

stop_schedulers() {
  local pid=""

  for pid in "${scheduler_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for pid in "${scheduler_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  scheduler_pids=()
}

handle_shutdown() {
  if [ "$shutdown_requested" -ne 0 ]; then
    return 0
  fi

  shutdown_requested=1
  mkdir -p "$(dirname "$shutdown_flag_file")" 2>/dev/null || true
  : > "$shutdown_flag_file"
  log "Shutdown signal received; stopping new launches"
  stop_schedulers
  stop_controller_workers
  stop_job_subshells
}

cleanup() {
  stop_schedulers
  stop_controller_workers
  stop_job_subshells
  cleanup_temp_tokens
}

run_once_mode() {
  run_queue_maintenance 1

  queue_periodic_cycle
}

run_loop_mode() {
  local agent_id=""
  local offset=""

  run_queue_maintenance 1

  for agent_id in "${agent_ids[@]}"; do
    offset="$(compute_agent_offset "$target_repo" "$agent_id" "$periodic_interval")"
    start_agent_scheduler "$agent_id" "$offset"
  done

  log "Per-agent schedulers running; entering queue processing loop"

  while [ "$shutdown_requested" -eq 0 ]; do
    run_queue_maintenance 0
    process_queue
    reap_finished_jobs

    local live_schedulers=0
    local pid=""
    for pid in "${scheduler_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        live_schedulers=$((live_schedulers + 1))
      fi
    done

    if [ "${#scheduler_pids[@]}" -gt 0 ] && [ "$live_schedulers" -eq 0 ]; then
      log "All periodic schedulers have exited; shutting down"
      shutdown_requested=1
      failed_jobs=$((failed_jobs + 1))
      break
    fi

    sleep 1 &
    wait $! || true
  done
}
