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
  stop_watchers
  stop_controller_workers
  stop_job_subshells
}

cleanup() {
  stop_schedulers
  stop_watchers
  stop_controller_workers
  stop_job_subshells
  cleanup_temp_tokens
}

run_once_mode() {
  run_queue_maintenance 1
  if [ "$watch_tasks" = "1" ]; then
    queue_claimed_tasks_once
    return 0
  fi

  queue_periodic_cycle

  if [ "$watch_mentions" = "1" ]; then
    poll_mentions_once
  fi
  if [ "$watch_review_requests" = "1" ]; then
    poll_review_requests_once
  fi
  if [ "$watch_mentions" = "1" ] || [ "$watch_review_requests" = "1" ]; then
    process_queue
  fi
}

run_loop_mode() {
  local agent_id=""
  local offset=""

  run_queue_maintenance 1

  if [ "$watch_tasks" = "1" ]; then
    run_task_watch_loop
    return 0
  fi

  if [ "$watch_mentions" = "1" ]; then
    start_mention_watchers
  fi

  if [ "$watch_review_requests" = "1" ]; then
    start_review_request_watchers
  fi

  if [ "$watch_messaging" = "1" ]; then
    start_messaging_watcher
  fi

  for agent_id in "${agent_ids[@]}"; do
    # Messaging agent handles interactive chat — exclude from periodic
    # autonomous scheduling to avoid conflicts.
    if [ "$watch_messaging" = "1" ] && [ "$agent_id" = "$messaging_agent_id" ]; then
      continue
    fi
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

    if [ "$heartbeat_interval_secs" -gt 0 ] && [ -n "${HEALTH_REPORT_URL:-}" ]; then
      local now_epoch
      now_epoch="$(date +%s)"
      if [ $((now_epoch - last_heartbeat_epoch)) -ge "$heartbeat_interval_secs" ]; then
        fire_heartbeats
        last_heartbeat_epoch="$now_epoch"
      fi
    fi

    sleep 1 &
    wait $! || true
  done
}
