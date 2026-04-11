#!/usr/bin/env bash
# shellcheck disable=SC2154
# Telegram platform adapter for the messaging integration.
#
# Uses the hivemoot-agent Python CLI for outbound API calls (send,
# typing, validate) — proper error handling, chunking, token-from-file.
# Keeps the poll loop in bash for correct at-least-once offset control.
#
# Implements the adapter contract:
#   messaging_platform_check_deps
#   messaging_platform_validate_config
#   messaging_platform_send
#   messaging_platform_typing
#   messaging_platform_poll_loop
#   messaging_platform_extract_chat_id

[ -n "${HIVEMOOT_MESSAGING_PLATFORM_TELEGRAM_LOADED:-}" ] && return 0
HIVEMOOT_MESSAGING_PLATFORM_TELEGRAM_LOADED=1

# ── CLI resolution ─────────────────────────────────────────────────

_telegram_cli() {
  if ! command -v hivemoot-agent >/dev/null 2>&1; then
    echo "hivemoot-agent CLI not found in PATH" >&2
    return 1
  fi
  hivemoot-agent "$@"
}

# Build token args for the CLI.
_telegram_token_args() {
  if [ -n "${TELEGRAM_BOT_TOKEN_FILE:-}" ]; then
    printf -- '--token-file\n%s\n' "$TELEGRAM_BOT_TOKEN_FILE"
  fi
}

_telegram_has_token() {
  if [ -n "${TELEGRAM_BOT_TOKEN_FILE:-}" ]; then
    [ -f "$TELEGRAM_BOT_TOKEN_FILE" ]
    return
  fi

  [ -n "${TELEGRAM_BOT_TOKEN:-}" ]
}

# Raw Telegram API call (used only by the poll loop where bash needs
# to control offset advancement).  Token hidden from ps via curl -K.
_telegram_api() {
  local method="$1"; shift
  local token=""
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    token="$TELEGRAM_BOT_TOKEN"
  elif [ -n "${TELEGRAM_BOT_TOKEN_FILE:-}" ] && [ -f "$TELEGRAM_BOT_TOKEN_FILE" ]; then
    token="$(cat "$TELEGRAM_BOT_TOKEN_FILE")"
  else
    return 1
  fi
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$token" "$method" \
    | curl -sf --max-time 60 -K - "$@"
}

# ── Adapter contract ───────────────────────────────────────────────

messaging_platform_check_deps() {
  local missing=0
  for cmd in python3 curl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "Telegram adapter requires ${cmd}" >&2
      missing=$((missing + 1))
    fi
  done
  return "$missing"
}

messaging_platform_validate_config() {
  local -a token_args=()
  mapfile -t token_args < <(_telegram_token_args)
  if ! _telegram_has_token; then
    echo "TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN_FILE is required" >&2
    return 1
  fi
  _telegram_cli messaging validate --platform telegram "${token_args[@]}" 2>&1
}

messaging_platform_send() {
  local chat_id="$1"
  local text="$2"
  local -a token_args=()
  mapfile -t token_args < <(_telegram_token_args)

  # Pipe text via stdin — handles long messages, special chars, chunking.
  if ! printf '%s' "$text" | _telegram_cli messaging send \
    --platform telegram "${token_args[@]}" \
    --chat-id "$chat_id" 2>/dev/null; then
    log "messaging[telegram]: failed to send to chat_id=${chat_id}" 2>/dev/null || true
  fi
}

messaging_platform_typing() {
  local chat_id="$1"
  local -a token_args=()
  mapfile -t token_args < <(_telegram_token_args)

  _telegram_cli messaging typing \
    --platform telegram "${token_args[@]}" \
    --chat-id "$chat_id" >/dev/null 2>&1 || true
}

messaging_platform_extract_chat_id() {
  local session_key="$1"
  printf '%s' "${session_key#tg:}"
}

# ── Polling ────────────────────────────────────────────────────────

# Poll loop stays in bash for correct at-least-once offset control.
# Offset advances only after successful dispatch to the queue.
messaging_platform_poll_loop() {
  local agent_id="${messaging_agent_id}"
  local trigger_repo="${messaging_target_repo:-${target_repo:-}}"
  local poll_timeout="${TELEGRAM_POLL_TIMEOUT_SECS:-30}"
  local offset_file="${watch_state_root}/messaging-telegram-offset"
  local offset=0

  if [ -f "$offset_file" ]; then
    offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
  fi

  while true; do
    local response=""
    response="$(_telegram_api getUpdates \
      -d "offset=${offset}" \
      -d "timeout=${poll_timeout}" \
      -d "allowed_updates=[\"message\"]" 2>/dev/null)" || return 1

    if ! printf '%s' "$response" | jq -e '.ok == true' >/dev/null 2>&1; then
      log "messaging[telegram]: API returned error"
      return 1
    fi

    local updates="" update_count=0
    updates="$(printf '%s' "$response" | jq -c '.result // []')"
    update_count="$(printf '%s' "$updates" | jq 'length')"

    [ "$update_count" -eq 0 ] && continue

    local update=""
    while IFS= read -r update; do
      _telegram_handle_update "$update" "$agent_id" "$trigger_repo"
    done < <(printf '%s' "$updates" | jq -c '.[]')

    if [ -f "$offset_file" ]; then
      offset="$(cat "$offset_file" 2>/dev/null || echo "$offset")"
    fi
  done
}

# ── Internal ───────────────────────────────────────────────────────

_telegram_handle_update() {
  local update="$1"
  local agent_id="$2"
  local trigger_repo="$3"
  local offset_file="${watch_state_root}/messaging-telegram-offset"

  local update_id="" chat_id="" username="" text=""
  update_id="$(printf '%s' "$update" | jq -r '.update_id')"
  chat_id="$(printf '%s' "$update" | jq -r '.message.chat.id // empty')"
  username="$(printf '%s' "$update" | jq -r '.message.from.username // "unknown"')"
  text="$(printf '%s' "$update" | jq -r '.message.text // empty')"

  if [ -z "$text" ] || [ -z "$chat_id" ]; then
    printf '%s' "$((update_id + 1))" > "$offset_file"
    return 0
  fi

  if messaging_dispatch_update \
    "$agent_id" "$trigger_repo" \
    "$chat_id" "$username" "$text" \
    "tg:${chat_id}" "tg-msg:${update_id}"; then
    printf '%s' "$((update_id + 1))" > "$offset_file"
  fi
}
