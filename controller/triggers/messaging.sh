#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2034
# Messaging trigger — listen for inbound messages and enqueue jobs.
#
# Platform-specific polling is delegated to the messaging integration's
# adapter (integrations/messaging/platforms/<name>.sh).  This file
# handles only trigger concerns: session persistence, access control,
# enqueue, and the standard trigger hook contract.

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_MESSAGING_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_MESSAGING_LOADED=1

register_controller_trigger "messaging"

# The integration is sourced here (host-side) for polling and acks.
# The same integration is sourced by workloads/messaging/workload.sh
# inside the container for typing indicators and response delivery.
INTEGRATION_DIR="${INTEGRATION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/integrations}"
# shellcheck source=integrations/messaging/setup.sh
. "${INTEGRATION_DIR}/messaging/setup.sh"

# ── Persistent directory resolution ────────────────────────────────

messaging_sanitize_key() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

resolve_messaging_home() {
  local agent_id="$1"
  local session_key="$2"
  printf '%s/%s/%s' \
    "$messaging_homes_root" \
    "$agent_id" \
    "$(messaging_sanitize_key "$session_key")"
}

resolve_messaging_session_dir() {
  local agent_id="$1"
  printf '%s/%s' "$messaging_sessions_root" "$agent_id"
}

# ── Container discovery ────────────────────────────────────────────

messaging_find_running_container() {
  local session_key="$1"
  "$docker_cmd" ps -q \
    --filter "label=hivemoot.messaging.session_key=${session_key}" \
    --filter "label=hivemoot.controller.instance=${controller_instance_id}" \
    2>/dev/null | head -1
}

# ── Enqueue ────────────────────────────────────────────────────────

messaging_try_inject_or_enqueue() {
  local agent_id="$1"
  local session_key="$2"
  local text="$3"
  local combined_prompt="$4"
  local ack_key="$5"
  local trigger_repo="$6"
  local chat_id="$7"

  local container_id=""
  container_id="$(messaging_find_running_container "$session_key")"

  if [ -z "$container_id" ]; then
    write_trigger_file "messaging" "$trigger_repo" "$agent_id" \
      "$combined_prompt" "$ack_key" "" "$session_key"
    return $?
  fi

  # Container already running — enqueue without acking here.
  # on_duplicate_agent sends a one-time busy ack when the queue
  # processor picks it up, avoiding double-ack.
  # (Mid-execution injection via FIFO will be added in a follow-up.)
  write_trigger_file "messaging" "$trigger_repo" "$agent_id" \
    "$combined_prompt" "$ack_key" "" "$session_key"
}

# ── Dispatch (called by platform adapters) ─────────────────────────

messaging_dispatch_update() {
  local agent_id="$1"
  local trigger_repo="$2"
  local chat_id="$3"
  local username="$4"
  local text="$5"
  local session_key="$6"
  local ack_key="$7"

  [ -z "$text" ] && return 0
  [ -z "$chat_id" ] && return 0

  if ! messaging_is_allowed "$chat_id" "$username"; then
    log "messaging: denied chat_id=${chat_id} user=${username}"
    return 0
  fi

  if queue_has_ack_key "$ack_key"; then
    return 0
  fi

  log "messaging: received from ${username} in chat=${chat_id} (${#text} chars)"

  messaging_try_inject_or_enqueue \
    "$agent_id" "$session_key" "$text" "$text" \
    "$ack_key" "$trigger_repo" "$chat_id"
}

# ── Access control ─────────────────────────────────────────────────

messaging_is_allowed() {
  local chat_id="$1"
  local _username="$2"
  local allowed="${MESSAGING_ALLOWED_CHAT_IDS:-}"

  [ -z "$allowed" ] && return 1
  printf ',%s,' "$allowed" | grep -qF ",${chat_id},"
}

# ── Trigger hooks ──────────────────────────────────────────────────

controller_trigger_worker_workload__messaging() {
  printf '%s' "${MESSAGING_WORKLOAD:-messaging}"
}

controller_trigger_health_kind__messaging() {
  printf '%s' "messaging"
}

controller_trigger_global_slot_timeout_secs__messaging() {
  printf '%s' "${global_slot_timeout_messaging_secs:-600}"
}

controller_trigger_validate_queue_payload__messaging() {
  return 0
}

controller_trigger_prepare_job__messaging() {
  local job_id="$1"
  local agent_id="$3"
  local job_workspace="$4"
  local provider_name="$6"
  local base_extra_prompt="${11:-}"
  local base_session_key="${12:-}"

  local chat_key="${base_session_key:-messaging-default}"
  local msg_home=""
  local msg_session_dir=""

  msg_home="$(resolve_messaging_home "$agent_id" "$chat_key")"
  msg_session_dir="$(resolve_messaging_session_dir "$agent_id")"

  mkdir -p \
    "$msg_home/.config" \
    "$msg_home/.cache" \
    "$msg_home/.local/share"
  chmod 700 "$msg_home" 2>/dev/null || true

  mkdir -p "$msg_session_dir/sessions/${provider_name}"

  if [[ "$(uname -s)" == "Linux" ]]; then
    chown -R 1000:1000 "$msg_home" 2>/dev/null || true
    chown -R 1000:1000 "$msg_session_dir" 2>/dev/null || true
  fi

  controller_trigger_prepared_job_home="$msg_home"
  controller_trigger_prepared_persistent_session_dir="$msg_session_dir"
  controller_trigger_prepared_skip_credential_cleanup=1

  if [ -n "$base_session_key" ]; then
    controller_trigger_prepared_session_key="$base_session_key"
  else
    controller_trigger_prepared_session_key="messaging:${chat_key}"
  fi
}

controller_trigger_on_worker_exit__messaging() {
  local exit_code="$5"
  printf '%s\n' "$exit_code"
}

# When the messaging agent is already busy, send a one-time ack and
# requeue.  The ack flag is stored in the trigger file JSON so it
# survives the .processing ↔ .trigger.json rename cycle that happens
# on each queue pass.
controller_trigger_on_duplicate_agent__messaging() {
  local processing_file="$1"

  if [ -n "$processing_file" ] && [ -f "$processing_file" ]; then
    local already_acked=""
    already_acked="$(jq -r '.messaging_acked // "false"' "$processing_file" 2>/dev/null)"

    if [ "$already_acked" != "true" ]; then
      local dup_session_key=""
      dup_session_key="$(jq -r '.session_key // empty' "$processing_file" 2>/dev/null)"
      if [ -n "$dup_session_key" ]; then
        local dup_chat_id=""
        dup_chat_id="$(messaging_platform_extract_chat_id "$dup_session_key")"
        if [ -n "$dup_chat_id" ]; then
          messaging_platform_send "$dup_chat_id" \
            "I'm busy with another task right now — I'll get to your message shortly."
        fi
      fi

      # Mark as acked in the JSON so subsequent queue passes skip the ack.
      local tmp_file=""
      tmp_file="$(mktemp "${processing_file}.XXXXXX")"
      if jq -c '. + {messaging_acked: true}' "$processing_file" > "$tmp_file" 2>/dev/null; then
        mv -f "$tmp_file" "$processing_file"
      else
        rm -f "$tmp_file" 2>/dev/null || true
      fi
    fi
  fi

  requeue_processing_file "$processing_file"
}

# ── Watcher lifecycle ──────────────────────────────────────────────

start_messaging_watcher() {
  local watcher_pid=0

  log "Starting messaging watcher (platform=${MESSAGING_PLATFORM:-telegram} agent=${messaging_agent_id})"

  (
    trap 'command -v pkill >/dev/null 2>&1 && pkill -TERM -P "$$" >/dev/null 2>&1 || true; exit 0' TERM INT

    local restart_delay=5
    local max_delay=300
    local start_time=0
    local elapsed=0
    local poll_exit=0

    while true; do
      start_time=$SECONDS

      if messaging_platform_poll_loop; then
        :
      else
        poll_exit=$?
        log "messaging: poll loop exited (exit=${poll_exit})"
      fi

      elapsed=$((SECONDS - start_time))
      if [ "$elapsed" -gt 60 ]; then
        restart_delay=5
      fi

      log "messaging: restarting in ${restart_delay}s"
      sleep "$restart_delay" &
      wait $! || break

      restart_delay=$((restart_delay * 2))
      if [ "$restart_delay" -gt "$max_delay" ]; then
        restart_delay="$max_delay"
      fi
    done
  ) &

  watcher_pid=$!
  watcher_pids+=("$watcher_pid")
  log "Messaging watcher started (pid=${watcher_pid})"
}
