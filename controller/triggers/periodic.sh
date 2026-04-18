#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_PERIODIC_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_PERIODIC_LOADED=1

register_controller_trigger "periodic"

controller_trigger_global_slot_timeout_secs__periodic() {
  printf '%s' "$global_slot_timeout_periodic_secs"
}

controller_trigger_on_duplicate_agent__periodic() {
  local processing_file="$1"
  finalize_processing_file "$processing_file" "done"
}

controller_trigger_on_global_slot_timeout__periodic() {
  local processing_file="$1"
  local job_id="$2"
  local repo="$3"
  local agent_id="$4"
  local timeout_secs="$5"

  finalize_processing_file "$processing_file" "done"
  log "Global slot timeout (${timeout_secs}s); skipping periodic trigger: id=${job_id} repo=${repo} agent=${agent_id}"
}

controller_trigger_on_success__periodic() {
  local processing_file="$1"
  finalize_processing_file "$processing_file" "done"
  return 0
}

controller_trigger_on_failure__periodic() {
  local processing_file="$1"
  finalize_processing_file "$processing_file" "failed"
  return 0
}

queue_periodic_cycle() {
  local agent_id=""
  local job_id=""

  log "Queueing periodic cycle for ${agent_count} agent(s)"

  for agent_id in "${agent_ids[@]}"; do
    if [ "$shutdown_requested" -ne 0 ]; then
      break
    fi

    job_id="$(generate_job_id)"
    if ! launch_job "$job_id" "$target_repo" "$agent_id" "periodic" "$global_extra_prompt" "" "" ""; then
      break
    fi
  done
}

start_agent_scheduler() {
  local agent_id="$1"
  local offset="$2"

  (
    trap 'exit 0' TERM INT

    if [ "$offset" -gt 0 ]; then
      log "Scheduler[${agent_id}]: initial offset sleep ${offset}s"
      sleep "$offset" &
      wait $! || exit 0
    fi

    while [ ! -f "$shutdown_flag_file" ]; do
      if write_trigger_file "periodic" "$target_repo" "$agent_id" "$global_extra_prompt" "" "" ""; then
        log "Scheduler[${agent_id}]: queued periodic trigger"
      else
        log "Scheduler[${agent_id}]: failed to queue trigger"
      fi

      local delay=""
      delay="$(next_cycle_delay)"
      log "Scheduler[${agent_id}]: next run in ${delay}s"
      sleep "$delay" &
      wait $! || exit 0
    done
  ) &

  local pid=$!
  scheduler_pids+=("$pid")
  log "Agent scheduler started: agent=${agent_id} offset=${offset}s (pid=${pid})"
}

next_cycle_delay() {
  local jitter="${periodic_jitter}"
  local min_delay=""
  local max_delay=""
  local span=""

  if [ "$periodic_interval" -le 1 ]; then
    echo 1
    return 0
  fi

  if [ "$jitter" -ge "$periodic_interval" ]; then
    jitter=$((periodic_interval - 1))
  fi

  min_delay=$((periodic_interval - jitter))
  max_delay=$((periodic_interval + jitter))
  span=$((max_delay - min_delay + 1))
  echo $((min_delay + RANDOM % span))
}
