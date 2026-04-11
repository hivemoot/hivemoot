#!/usr/bin/env bash
# shellcheck disable=SC2154
# Messaging integration — platform-agnostic messaging API.
#
# Loads the platform adapter for MESSAGING_PLATFORM and exports shared
# helpers.  Sourced by both the workload (inside the container) and the
# trigger (on the host).
#
# After sourcing, the following functions are available:
#   messaging_platform_send              chat_id text  — send a text message
#   messaging_platform_typing            chat_id       — send typing indicator
#   messaging_platform_extract_chat_id   session_key   — parse chat ID from key
#
# Platform adapters live in platforms/<name>.sh and must implement:
#   messaging_platform_check_deps
#   messaging_platform_validate_config
#   messaging_platform_send
#   messaging_platform_typing
#   messaging_platform_poll_loop
#   messaging_platform_extract_chat_id

[ -n "${HIVEMOOT_INTEGRATION_MESSAGING_SETUP_LOADED:-}" ] && return 0
HIVEMOOT_INTEGRATION_MESSAGING_SETUP_LOADED=1

_MESSAGING_INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load the platform adapter.  Called once during init.
messaging_load_platform() {
  local platform="${MESSAGING_PLATFORM:-telegram}"
  local adapter_file="${_MESSAGING_INTEGRATION_DIR}/platforms/${platform}.sh"

  if [ ! -f "$adapter_file" ]; then
    echo "Unknown MESSAGING_PLATFORM '${platform}' (no adapter at ${adapter_file})" >&2
    return 1
  fi

  # shellcheck disable=SC1090
  . "$adapter_file"

  # Verify the adapter implements the required contract.
  local fn=""
  for fn in messaging_platform_check_deps \
            messaging_platform_validate_config \
            messaging_platform_send \
            messaging_platform_typing \
            messaging_platform_poll_loop \
            messaging_platform_extract_chat_id; do
    if ! declare -F "$fn" >/dev/null 2>&1; then
      echo "Messaging adapter '${platform}' missing required function: ${fn}" >&2
      return 1
    fi
  done
}

# ── Typing indicator lifecycle ─────────────────────────────────────

# Start a background loop that sends typing indicators every 4 seconds.
# Returns the PID via stdout.  Caller is responsible for killing it.
messaging_start_typing_loop() {
  local chat_id="$1"
  (
    trap 'exit 0' TERM INT
    while true; do
      messaging_platform_typing "$chat_id" || true
      sleep 4 &
      wait $! || exit 0
    done
  ) >/dev/null 2>&1 &
  printf '%d' "$!"
}
