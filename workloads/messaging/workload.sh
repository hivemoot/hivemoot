#!/usr/bin/env bash
# shellcheck disable=SC2154
# Messaging workload — conversational agent responses.
#
# ── Hooks ─────────────────────────────────────────────────────────
#   workload_integration       — "messaging"
#   workload_setup             — load integration, optional repo clone
#   workload_preflight         — validate prompt file
#   workload_build_prompt      — conversational instructions
#   workload_user_message      — the inbound chat message
#   workload_skills_dir        — skills path (inherits hivemoot skills)
#   workload_pre_execute       — start typing indicator
#   workload_post_execute      — send response, stop typing
# ──────────────────────────────────────────────────────────────────

WORKLOAD_MESSAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="${INTEGRATION_DIR:-/opt/hivemoot-agent/integrations}"

# Source the messaging integration (provides messaging_platform_send,
# messaging_platform_typing, messaging_start_typing_loop).
# shellcheck source=integrations/messaging/setup.sh
. "${INTEGRATION_DIR}/messaging/setup.sh"

# ── State ──────────────────────────────────────────────────────────

_messaging_typing_pid=""
_messaging_chat_id=""

# ── Manifest ──────────────────────────────────────────────────────

workload_integration() { printf '%s' "messaging"; }

# ── Lifecycle hooks ───────────────────────────────────────────────

workload_setup() {
  # Load the platform adapter so messaging_platform_send/typing work.
  messaging_load_platform

  # Extract chat_id from the session key via the platform adapter.
  # The trigger passes it via AGENT_SESSION_KEY.
  if [ -n "${AGENT_SESSION_KEY:-}" ]; then
    _messaging_chat_id="$(messaging_platform_extract_chat_id "$AGENT_SESSION_KEY")"
  fi

  # Messaging jobs do not clone a repo by default.  Create an empty
  # working directory so the provider's cd "$repo_dir" succeeds.
  # Repo-aware messaging (lazy clone on demand) is a follow-up feature.
  mkdir -p "${repo_dir:?repo_dir must be set by run-once.sh}"
}

workload_preflight() {
  local failures=0
  if [ ! -f "${WORKLOAD_MESSAGING_DIR}/prompts/messaging.md" ]; then
    echo "Pre-flight: messaging prompt not found: ${WORKLOAD_MESSAGING_DIR}/prompts/messaging.md" >&2
    failures=$((failures + 1))
  fi
  return "$failures"
}

workload_build_prompt() {
  cat "${WORKLOAD_MESSAGING_DIR}/prompts/messaging.md"
}

workload_user_message() {
  printf '%s' "Respond to the user's message."
}

workload_skills_dir() {
  # Reuse the hivemoot skills library.
  printf '%s' "${WORKLOAD_MESSAGING_DIR}/../hivemoot/skills"
}

# ── Pre/post execute hooks ────────────────────────────────────────

workload_pre_execute() {
  # Start typing indicator for the chat.
  if [ -n "$_messaging_chat_id" ]; then
    _messaging_typing_pid="$(messaging_start_typing_loop "$_messaging_chat_id")"
  fi
}

workload_post_execute() {
  local exit_code="$1"
  local log_file="$2"
  local provider="$3"

  # Stop typing indicator.
  if [ -n "$_messaging_typing_pid" ]; then
    kill "$_messaging_typing_pid" 2>/dev/null || true
    wait "$_messaging_typing_pid" 2>/dev/null || true
    _messaging_typing_pid=""
  fi

  # Extract the agent's response and send it back to the chat.
  [ -z "$_messaging_chat_id" ] && return 0
  [ -z "$log_file" ] && return 0
  [ ! -f "$log_file" ] && return 0

  # Use the CLI for response extraction — proper JSON parsing for all providers.
  local response=""
  if command -v hivemoot-agent >/dev/null 2>&1; then
    response="$(hivemoot-agent extract response --provider "$provider" --log-file "$log_file" 2>/dev/null)"
  fi

  if [ -n "$response" ]; then
    messaging_platform_send "$_messaging_chat_id" "$response"
  elif [ "$exit_code" -ne 0 ]; then
    messaging_platform_send "$_messaging_chat_id" \
      "Something went wrong processing your message. I'll try again next time."
  fi
}
