"""Telegram Bot API adapter.

All functions use stdlib only (urllib). Token is never placed in argv —
it's read from a file and used only in HTTP request URLs via urllib
(not visible to ps).
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Telegram's maximum message length.
MAX_MESSAGE_LENGTH = 4096


def _api(token: str, method: str, data: dict[str, Any] | None = None) -> dict:
    """Call a Telegram Bot API method. Returns the parsed JSON response."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=65) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            err_body = json.loads(exc.read())
        except Exception:
            err_body = {}

        if status == 401:
            print(
                "telegram: bot token is invalid or revoked (HTTP 401)",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc

        if status == 429:
            retry_after = err_body.get("parameters", {}).get("retry_after", "?")
            print(
                f"telegram: rate limited (HTTP 429, retry_after={retry_after}s)",
                file=sys.stderr,
            )

        raise
    except urllib.error.URLError as exc:
        print(f"telegram: network error: {exc.reason}", file=sys.stderr)
        raise


def validate_token(token: str) -> bool:
    """Validate the bot token with getMe."""
    try:
        resp = _api(token, "getMe")
        if resp.get("ok"):
            bot = resp["result"]
            print(
                f"telegram: token valid — @{bot.get('username', '?')} "
                f"(id={bot.get('id', '?')})",
                file=sys.stderr,
            )
            return True
        return False
    except Exception:
        return False


def poll(token: str, offset: int, timeout: int) -> list[dict]:
    """Long-poll getUpdates. Returns a list of normalized message dicts.

    Each dict: {chat_id, username, text, update_id, session_key, ack_key}
    Non-text updates are skipped but their offset is still advanced.
    """
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

        messages.append(
            {
                "update_id": update_id,
                "chat_id": chat_id,
                "username": username,
                "text": text,
                "session_key": f"tg:{chat_id}" if chat_id else "",
                "ack_key": f"tg-msg:{update_id}",
            }
        )

    return messages


def send(token: str, chat_id: str, text: str) -> bool:
    """Send a text message. Chunks long messages at 4096 chars.

    Returns True if all chunks were sent successfully.
    """
    chunks = _chunk_text(text, MAX_MESSAGE_LENGTH)
    ok = True
    for chunk in chunks:
        try:
            resp = _api(
                token,
                "sendMessage",
                {"chat_id": chat_id, "text": chunk},
            )
            if not resp.get("ok"):
                desc = resp.get("description", "unknown error")
                print(
                    f"telegram: send failed for chat {chat_id}: {desc}",
                    file=sys.stderr,
                )
                ok = False
        except Exception as exc:
            print(
                f"telegram: send error for chat {chat_id}: {exc}",
                file=sys.stderr,
            )
            ok = False
    return ok


def typing(token: str, chat_id: str) -> bool:
    """Send a typing indicator."""
    try:
        resp = _api(
            token,
            "sendChatAction",
            {"chat_id": chat_id, "action": "typing"},
        )
        return resp.get("ok", False)
    except Exception:
        return False


def _chunk_text(text: str, max_len: int) -> list[str]:
    """Split text into chunks, preferring line breaks as split points."""
    if len(text) <= max_len:
        return [text]

    chunks: list[str] = []
    while text:
        if len(text) <= max_len:
            chunks.append(text)
            break

        # Try to split at the last newline within the limit.
        split_at = text.rfind("\n", 0, max_len)
        if split_at <= 0:
            # No good newline — hard split at limit.
            split_at = max_len

        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")

    return chunks
