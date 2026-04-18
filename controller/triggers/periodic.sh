#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_PERIODIC_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_PERIODIC_LOADED=1

register_controller_trigger "periodic"

controller_trigger_health_kind__periodic() {
  printf '%s' "scheduled"
}

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

fire_heartbeats() {
  # Token is resolved by `hivemoot-agent health heartbeat` directly
  # from HIVEMOOT_AGENT_TOKEN_FILE / HIVEMOOT_AGENT_TOKEN env, which
  # the controller process already exports.  HIVEMOOT_AGENT_CLI is
  # resolved once at controller startup in controller/main.sh.
  local next_run_at agent_id rc=0
  next_run_at="$(date -u -d "+${periodic_interval} seconds" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -v "+${periodic_interval}S" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || true)"
  for agent_id in "${agent_ids[@]}"; do
    rc=0
    "$HIVEMOOT_AGENT_CLI" health heartbeat \
      --agent "$agent_id" \
      --repo "$target_repo" \
      --next-run-at "$next_run_at" || rc=$?
    if [ "$rc" -eq 2 ]; then
      # argparse usage error — a regression in the controller's CLI
      # invocation (renamed flag, missing required arg).  Operational
      # failures are exit 0 with stderr by design, so a non-zero rc
      # here always means we mis-invoked the CLI.
      log "Heartbeat invocation rejected by CLI (rc=2, usage error) for agent=${agent_id}"
    elif [ "$rc" -ne 0 ]; then
      log "Heartbeat invocation failed (rc=${rc}) for agent=${agent_id}"
    else
      log "Heartbeat attempted: agent=${agent_id}"
    fi
  done
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
