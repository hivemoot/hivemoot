#!/usr/bin/env bash
# lib-global-slots.sh -- host-wide flock semaphore for controller worker slots.
#
# Dependencies (must be sourced before this file):
#   scripts/lib.sh -- provides trim()
#
# Idempotency guard: re-sourcing is a no-op.
[ -n "${HIVEMOOT_LIB_GLOBAL_SLOTS_LOADED:-}" ] && return 0
HIVEMOOT_LIB_GLOBAL_SLOTS_LOADED=1

HIVEMOOT_GLOBAL_SLOTS_ENABLED=0
HIVEMOOT_GLOBAL_SLOTS_COUNT=0
HIVEMOOT_GLOBAL_SLOT_FD=""
declare -a global_slot_files=()

global_slots_warn() {
  printf '[global-slots] %s\n' "$*" >&2
}

close_slot_fd() {
  local fd="$1"

  [ -n "$fd" ] || return 0
  eval "exec ${fd}>&-"
}

try_acquire_slot_file_nonblocking() {
  local slot_file="$1"
  local fd=""

  exec {fd}>>"$slot_file"
  if flock -n "$fd"; then
    HIVEMOOT_GLOBAL_SLOT_FD="$fd"
    return 0
  fi

  close_slot_fd "$fd"
  return 1
}

wait_for_slot_file() {
  local slot_file="$1"
  local timeout_secs="$2"
  local fd=""

  exec {fd}>>"$slot_file"
  if flock -w "$timeout_secs" "$fd"; then
    HIVEMOOT_GLOBAL_SLOT_FD="$fd"
    return 0
  fi

  close_slot_fd "$fd"
  return 1
}

init_global_slots() {
  local slots_dir="$1"
  local count="$2"
  local slot_index=0
  local slot_file=""

  HIVEMOOT_GLOBAL_SLOTS_ENABLED=0
  HIVEMOOT_GLOBAL_SLOTS_COUNT=0
  HIVEMOOT_GLOBAL_SLOT_FD=""
  global_slot_files=()

  if [ -z "$count" ] || [ "$count" -le 0 ]; then
    return 0
  fi

  slots_dir="$(trim "$slots_dir")"
  if [ -z "$slots_dir" ]; then
    global_slots_warn "disabled: GLOBAL_SLOTS_DIR is required when GLOBAL_MAX_WORKERS>0"
    return 0
  fi

  case "$slots_dir" in
    /*) ;;
    *)
      global_slots_warn "disabled: GLOBAL_SLOTS_DIR must be an absolute path: ${slots_dir}"
      return 0
      ;;
  esac

  if [ ! -d "$slots_dir" ]; then
    global_slots_warn "disabled: global slot directory does not exist: ${slots_dir}"
    return 0
  fi

  for slot_index in $(seq 1 "$count"); do
    slot_file="${slots_dir}/slot-${slot_index}.lock"
    if ! : > "$slot_file"; then
      global_slots_warn "disabled: failed to initialize slot file: ${slot_file}"
      global_slot_files=()
      return 0
    fi
    chmod 600 "$slot_file" 2>/dev/null || true
    global_slot_files+=("$slot_file")
  done

  HIVEMOOT_GLOBAL_SLOTS_ENABLED=1
  HIVEMOOT_GLOBAL_SLOTS_COUNT="$count"
}

acquire_global_slot() {
  local timeout_secs="$1"
  local start_index=0
  local offset=0
  local slot_index=0
  local slot_file=""
  local deadline=0
  local remaining=0
  local wait_timeout=0

  if [ "${HIVEMOOT_GLOBAL_SLOTS_ENABLED:-0}" != "1" ]; then
    return 0
  fi

  if [ -n "${HIVEMOOT_GLOBAL_SLOT_FD:-}" ]; then
    return 0
  fi

  if [ "$HIVEMOOT_GLOBAL_SLOTS_COUNT" -le 0 ]; then
    return 0
  fi

  if [ "$HIVEMOOT_GLOBAL_SLOTS_COUNT" -gt 1 ]; then
    start_index=$((RANDOM % HIVEMOOT_GLOBAL_SLOTS_COUNT))
  fi

  if [ "$timeout_secs" -lt 0 ]; then
    timeout_secs=0
  fi
  deadline=$((SECONDS + timeout_secs))

  while true; do
    for offset in $(seq 0 $((HIVEMOOT_GLOBAL_SLOTS_COUNT - 1))); do
      slot_index=$(((start_index + offset) % HIVEMOOT_GLOBAL_SLOTS_COUNT))
      slot_file="${global_slot_files[$slot_index]}"
      if try_acquire_slot_file_nonblocking "$slot_file"; then
        return 0
      fi
    done

    remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      return 1
    fi

    slot_index=$((RANDOM % HIVEMOOT_GLOBAL_SLOTS_COUNT))
    slot_file="${global_slot_files[$slot_index]}"
    wait_timeout="$remaining"
    if [ "$wait_timeout" -gt 1 ]; then
      wait_timeout=1
    fi
    if wait_for_slot_file "$slot_file" "$wait_timeout"; then
      return 0
    fi
  done
}

release_global_slot() {
  if [ "${HIVEMOOT_GLOBAL_SLOTS_ENABLED:-0}" != "1" ]; then
    return 0
  fi

  if [ -z "${HIVEMOOT_GLOBAL_SLOT_FD:-}" ]; then
    return 0
  fi

  flock -u "$HIVEMOOT_GLOBAL_SLOT_FD" 2>/dev/null || true
  close_slot_fd "$HIVEMOOT_GLOBAL_SLOT_FD"
  HIVEMOOT_GLOBAL_SLOT_FD=""
}
