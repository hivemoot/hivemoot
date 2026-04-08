#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_TRIGGER_GITHUB_COMMON_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_TRIGGER_GITHUB_COMMON_LOADED=1

state_file_in_watch_root() {
  local state_file="$1"

  case "$state_file" in
    "${watch_state_root}/"*) return 0 ;;
    *) return 1 ;;
  esac
}

ack_watch_event() {
  local agent_id="$1"
  local ack_key="$2"
  local state_file="$3"
  local token_file="${agent_token_files[$agent_id]:-}"

  if [ -z "$ack_key" ] || [ -z "$state_file" ]; then
    return 0
  fi

  if ! state_file_in_watch_root "$state_file"; then
    log "Skipping ack for ${agent_id}: invalid state file path (${state_file})"
    return 1
  fi

  if [ -z "$token_file" ] || [ ! -f "$token_file" ]; then
    log "Skipping ack for ${agent_id}: missing token file"
    return 1
  fi

  if GH_TOKEN="$(cat "$token_file")" hivemoot ack "$ack_key" --state-file "$state_file" >/dev/null 2>&1; then
    log "Notification acked: agent=${agent_id} key=${ack_key}"
    return 0
  fi

  log "Ack failed: agent=${agent_id} key=${ack_key}"
  return 1
}

stop_watchers() {
  local pid=""

  for pid in "${watcher_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for pid in "${watcher_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  watcher_pids=()
}
