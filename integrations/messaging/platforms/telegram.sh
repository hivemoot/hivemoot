#!/usr/bin/env bash
# shellcheck disable=SC2154
# Telegram platform adapter for the messaging integration.
#
# Implements the adapter contract:
#   messaging_platform_check_deps
#   messaging_platform_validate_config
#   messaging_platform_send
#   messaging_platform_typing
#   messaging_platform_poll_loop

[ -n "${HIVEMOOT_MESSAGING_PLATFORM_TELEGRAM_LOADED:-}" ] && return 0
HIVEMOOT_MESSAGING_PLATFORM_TELEGRAM_LOADED=1

# ── Token resolution ───────────────────────────────────────────────

_telegram_resolve_bot_token() {
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    printf '%s' "$TELEGRAM_BOT_TOKEN"
    return 0
  fi
  if [ -n "${TELEGRAM_BOT_TOKEN_FILE:-}" ] && [ -f "$TELEGRAM_BOT_TOKEN_FILE" ]; then
    cat "$TELEGRAM_BOT_TOKEN_FILE"
    return 0
  fi
  return 1
}

# ── Bot API ────────────────────────────────────────────────────────

_telegram_api() {
  local method="$1"; shift
  local token=""
  if ! token="$(_telegram_resolve_bot_token)"; then
    echo "_telegram_api: bot token not configured" >&2
    return 1
  fi
  # Pass the URL via curl -K stdin so the bot token does not appear in
  # the process argv visible to ps(1).
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$token" "$method" \
    | curl -sf --max-time 60 -K - "$@"
}

# ── Adapter contract ───────────────────────────────────────────────

messaging_platform_check_deps() {
  local missing=0
  for cmd in curl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "Telegram adapter requires ${cmd}" >&2
      missing=$((missing + 1))
    fi
  done
  return "$missing"
}

messaging_platform_validate_config() {
  if ! _telegram_resolve_bot_token >/dev/null 2>&1; then
    echo "TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN_FILE is required" >&2
    return 1
  fi
  # Validate the token against the Telegram API.
  if ! _telegram_api getMe >/dev/null 2>&1; then
    echo "Telegram bot token is invalid (getMe failed)" >&2
    return 1
  fi
}

# Extract the chat ID from a platform-specific session key.
# Telegram keys have the format "tg:<chat_id>".
messaging_platform_extract_chat_id() {
  local session_key="$1"
  printf '%s' "${session_key#tg:}"
}

messaging_platform_send() {
  local chat_id="$1"
  local text="$2"
  # Send as plain text — agent output contains unescaped characters
  # (_, *, `, [) that break Telegram's Markdown parser.  Log failures
  # instead of swallowing them silently.
  if ! _telegram_api sendMessage \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1; then
    log "messaging[telegram]: failed to send message to chat_id=${chat_id}" 2>/dev/null || true
  fi
}

messaging_platform_typing() {
  local chat_id="$1"
  _telegram_api sendChatAction \
    -d "chat_id=${chat_id}" \
    -d "action=typing" >/dev/null 2>&1 || true
}

# ── Polling ────────────────────────────────────────────────────────

# Long-poll Telegram getUpdates and dispatch each message through
# messaging_dispatch_update() (defined in messaging.sh).
messaging_platform_poll_loop() {
  local agent_id="${messaging_agent_id}"
  local trigger_repo="${messaging_target_repo:-$target_repo}"
  local poll_timeout="${TELEGRAM_POLL_TIMEOUT_SECS:-30}"
  local offset_file="${watch_state_root}/messaging-telegram-offset"
  local offset=0
  local response=""
  local updates=""
  local update_count=0

  if [ -f "$offset_file" ]; then
    offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
  fi

  while true; do
    response="$(_telegram_api getUpdates \
      -d "offset=${offset}" \
      -d "timeout=${poll_timeout}" \
      -d "allowed_updates=[\"message\"]" 2>/dev/null)" || return 1

    if ! printf '%s' "$response" | jq -e '.ok == true' >/dev/null 2>&1; then
      log "messaging[telegram]: API returned error"
      return 1
    fi

    updates="$(printf '%s' "$response" | jq -c '.result // []')"
    update_count="$(printf '%s' "$updates" | jq 'length')"

    [ "$update_count" -eq 0 ] && continue

    local update=""
    while IFS= read -r update; do
      _telegram_handle_update "$update" "$agent_id" "$trigger_repo"
    done < <(printf '%s' "$updates" | jq -c '.[]')

    # Sync in-memory offset with the file that _telegram_handle_update wrote.
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

  local update_id=""
  local chat_id=""
  local username=""
  local text=""

  local offset_file="${watch_state_root}/messaging-telegram-offset"

  update_id="$(printf '%s' "$update" | jq -r '.update_id')"
  chat_id="$(printf '%s' "$update" | jq -r '.message.chat.id // empty')"
  username="$(printf '%s' "$update" | jq -r '.message.from.username // "unknown"')"
  text="$(printf '%s' "$update" | jq -r '.message.text // empty')"

  # Non-text / non-message updates: advance offset and skip.
  if [ -z "$text" ] || [ -z "$chat_id" ]; then
    printf '%s' "$((update_id + 1))" > "$offset_file"
    return 0
  fi

  # Dispatch to the generic layer.  Advance offset only on success so
  # a queue-write failure causes Telegram to re-deliver the message.
  # Dedup (queue_has_ack_key) handles the duplicate case on re-delivery.
  if messaging_dispatch_update \
    "$agent_id" "$trigger_repo" \
    "$chat_id" "$username" "$text" \
    "tg:${chat_id}" "tg-msg:${update_id}"; then
    printf '%s' "$((update_id + 1))" > "$offset_file"
  fi
}
