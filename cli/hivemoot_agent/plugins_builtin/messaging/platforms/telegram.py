"""Telegram Bot API adapter — internal to the messaging plugin.

All API calls use stdlib urllib.  Token is read from file or env var,
never placed in process argv.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from hivemoot_agent.plugins.interfaces import PluginConfig

MAX_MESSAGE_LENGTH = 4096


# ── API ────────────────────────────────────────────────────────────


def _api(token: str, method: str, data: dict[str, Any] | None = None) -> dict:
    """Call a Telegram Bot API method."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=65) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print("telegram: token invalid (HTTP 401)", file=sys.stderr)
            raise
        if exc.code == 429:
            try:
                err_body = json.loads(exc.read())
                retry = err_body.get("parameters", {}).get("retry_after", "?")
            except Exception:
                retry = "?"
            print(f"telegram: rate limited (retry_after={retry}s)", file=sys.stderr)
        raise


def _resolve_token(config: PluginConfig) -> str:
    """Resolve bot token from config or env."""
    token = config.get("TELEGRAM_BOT_TOKEN", "")
    if token:
        return token

    token_file = config.get("TELEGRAM_BOT_TOKEN_FILE", "")
    if token_file and os.path.isfile(token_file):
        with open(token_file) as f:
            return f.read().strip()

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if token:
        return token

    token_file = os.environ.get("TELEGRAM_BOT_TOKEN_FILE", "")
    if token_file and os.path.isfile(token_file):
        with open(token_file) as f:
            return f.read().strip()

    return ""


def _http_error_description(exc: urllib.error.HTTPError) -> str:
    """Extract Telegram's error description from an HTTPError body."""
    try:
        body = exc.read()
    except Exception:
        return ""
    if not body:
        return ""
    try:
        parsed = json.loads(body)
    except Exception:
        return ""
    return str(parsed.get("description", ""))


# ── Adapter ────────────────────────────────────────────────────────


class TelegramAdapter:
    """Telegram Bot API adapter."""

    name = "telegram"

    def validate_config(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        token = _resolve_token(config)
        if not token:
            errors.append(
                "TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN_FILE is required"
            )
            return errors
        try:
            resp = _api(token, "getMe")
            if resp.get("ok"):
                bot = resp["result"]
                print(
                    f"telegram: token valid — @{bot.get('username', '?')}",
                    file=sys.stderr,
                )
            else:
                errors.append("Telegram bot token is invalid")
        except Exception:
            errors.append("Telegram bot token validation failed")
        return errors

    def poll(
        self, config: PluginConfig, offset: int, timeout: int = 30
    ) -> list[dict]:
        """Long-poll getUpdates.  Returns normalized message dicts."""
        token = _resolve_token(config)
        if not token:
            return []
        try:
            resp = _api(
                token,
                "getUpdates",
                {
                    "offset": offset,
                    "timeout": timeout,
                    "allowed_updates": '["message"]',
                },
            )
        except Exception:
            return []

        if not resp.get("ok"):
            return []

        messages: list[dict] = []
        for update in resp.get("result", []):
            update_id = update.get("update_id", 0)
            msg = update.get("message", {})
            chat_id = str(msg.get("chat", {}).get("id", ""))
            username = msg.get("from", {}).get("username", "unknown")
            text = msg.get("text", "")
            messages.append({
                "update_id": update_id,
                "chat_id": chat_id,
                "username": username,
                "text": text,
            })
        return messages

    def send(self, config: PluginConfig, chat_id: str, text: str) -> bool:
        """Send a text message with Markdown→HTML formatting.

        Converts agent Markdown to Telegram HTML, chunks at 4096 chars,
        and falls back to plain text if Telegram rejects the HTML.
        """
        from hivemoot_agent.plugins_builtin.messaging.formatter import (
            markdown_to_telegram_html,
        )

        token = _resolve_token(config)
        if not token:
            return False

        html = markdown_to_telegram_html(text)
        ok = True

        for chunk in _chunk_text(html, MAX_MESSAGE_LENGTH):
            try:
                resp = _api(
                    token, "sendMessage",
                    {"chat_id": chat_id, "text": chunk, "parse_mode": "HTML"},
                )
                if not resp.get("ok"):
                    desc = resp.get("description", "")
                    # Fallback: if Telegram can't parse HTML, resend as plain text.
                    if "can't parse entities" in desc:
                        plain_chunk = _chunk_text(text, MAX_MESSAGE_LENGTH)
                        for pc in plain_chunk:
                            _api(token, "sendMessage", {"chat_id": chat_id, "text": pc})
                        break
                    print(f"telegram: send failed: {desc}", file=sys.stderr)
                    ok = False
            except Exception as exc:
                print(f"telegram: send error: {exc}", file=sys.stderr)
                ok = False
        return ok

    def typing(self, config: PluginConfig, chat_id: str) -> bool:
        """Send typing indicator."""
        token = _resolve_token(config)
        if not token:
            return False
        try:
            resp = _api(
                token, "sendChatAction",
                {"chat_id": chat_id, "action": "typing"},
            )
            return resp.get("ok", False)
        except Exception:
            return False

    def send_and_get_id(
        self, config: PluginConfig, chat_id: str, text: str,
    ) -> str:
        """Send a message with Markdown->HTML formatting and return its message_id.

        Returns "" on failure.  Falls back to plain text if Telegram
        rejects the HTML.
        """
        from hivemoot_agent.plugins_builtin.messaging.formatter import (
            markdown_to_telegram_html,
        )

        token = _resolve_token(config)
        if not token:
            return ""
        html = markdown_to_telegram_html(text)
        try:
            resp = _api(
                token, "sendMessage",
                {"chat_id": chat_id, "text": html, "parse_mode": "HTML"},
            )
            if resp.get("ok"):
                return str(resp["result"]["message_id"])
            # Fallback to plain text.
            resp = _api(token, "sendMessage", {"chat_id": chat_id, "text": text})
            if resp.get("ok"):
                return str(resp["result"]["message_id"])
        except urllib.error.HTTPError as exc:
            description = _http_error_description(exc)
            if "can't parse entities" in description:
                try:
                    resp = _api(
                        token, "sendMessage",
                        {"chat_id": chat_id, "text": text},
                    )
                    if resp.get("ok"):
                        return str(resp["result"]["message_id"])
                except Exception as fallback_exc:
                    print(
                        f"telegram: send_and_get_id fallback error: {fallback_exc}",
                        file=sys.stderr,
                    )
                    return ""
            print(f"telegram: send_and_get_id error: {exc}", file=sys.stderr)
        except Exception as exc:
            print(f"telegram: send_and_get_id error: {exc}", file=sys.stderr)
        return ""

    def edit_message(
        self, config: PluginConfig, chat_id: str, message_id: str, text: str,
    ) -> bool:
        """Edit a message's text with Markdown->HTML formatting.  Returns True on success."""
        from hivemoot_agent.plugins_builtin.messaging.formatter import (
            markdown_to_telegram_html,
        )

        token = _resolve_token(config)
        if not token:
            return False
        html = markdown_to_telegram_html(text)
        try:
            resp = _api(
                token, "editMessageText",
                {"chat_id": chat_id, "message_id": message_id,
                 "text": html, "parse_mode": "HTML"},
            )
            if resp.get("ok"):
                return True
            # Fallback to plain text.
            resp = _api(
                token, "editMessageText",
                {"chat_id": chat_id, "message_id": message_id, "text": text},
            )
            return resp.get("ok", False)
        except urllib.error.HTTPError as exc:
            description = _http_error_description(exc)
            if "message is not modified" in description:
                return True
            if "can't parse entities" in description:
                try:
                    resp = _api(
                        token, "editMessageText",
                        {"chat_id": chat_id, "message_id": message_id, "text": text},
                    )
                    return resp.get("ok", False)
                except Exception as fallback_exc:
                    print(
                        f"telegram: edit_message fallback error: {fallback_exc}",
                        file=sys.stderr,
                    )
                    return False
            print(f"telegram: edit_message error: {exc}", file=sys.stderr)
            return False
        except Exception as exc:
            print(f"telegram: edit_message error: {exc}", file=sys.stderr)
            return False

    def delete_message(
        self, config: PluginConfig, chat_id: str, message_id: str,
    ) -> bool:
        """Delete a message.  Returns True on success."""
        token = _resolve_token(config)
        if not token:
            return False
        try:
            resp = _api(
                token, "deleteMessage",
                {"chat_id": chat_id, "message_id": message_id},
            )
            return resp.get("ok", False)
        except urllib.error.HTTPError as exc:
            # "message to delete not found" is fine — already gone.
            try:
                body = json.loads(exc.read())
                if "message to delete not found" in body.get("description", ""):
                    return True
            except Exception:
                pass
            print(f"telegram: delete_message error: {exc}", file=sys.stderr)
            return False
        except Exception as exc:
            print(f"telegram: delete_message error: {exc}", file=sys.stderr)
            return False


def _chunk_text(text: str, max_len: int) -> list[str]:
    """Split text at line breaks, respecting max_len."""
    if len(text) <= max_len:
        return [text]
    chunks: list[str] = []
    while text:
        if len(text) <= max_len:
            chunks.append(text)
            break
        split_at = text.rfind("\n", 0, max_len)
        if split_at <= 0:
            split_at = max_len
        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    return chunks
