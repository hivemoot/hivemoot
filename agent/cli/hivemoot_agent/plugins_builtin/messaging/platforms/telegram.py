"""Telegram Bot API adapter — internal to the messaging plugin.

All API calls use stdlib urllib.  Token is read from file or env var,
never placed in process argv.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from hivemoot_agent.plugins.interfaces import PluginConfig

MAX_MESSAGE_LENGTH = 4096

# Telegram bot file size limits (per Bot API docs).  Photo attachments
# are auto-recompressed by Telegram and capped at 10 MB; documents
# preserve quality and cap at 50 MB.  We surface a clear error before
# uploading something the API will reject.
_TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024
_TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024

# Extensions we route to sendPhoto by default (gets inline preview in
# Telegram clients).  Anything else goes to sendDocument (preserves
# original filename + bytes).  --as-document overrides to always use
# sendDocument even for images.
_PHOTO_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})

# Bot API getFile limit — files larger than this need MTProto.  We
# detect + skip upstream with a clear message rather than silently
# truncating.
_TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024

# Order matters: we probe these media fields on each message in
# priority order and keep the first one present.  Reflects Telegram's
# "one attachment per message" model.  Sticker / animation / video_note
# are intentionally left out — they're rarely interesting to an agent
# and cost complexity for no clear use case.
_MEDIA_FIELDS = ("photo", "document", "audio", "voice", "video")


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
    """Read the Telegram bot token file named by MessagingConfig.bot_token_file.

    Under ADR-003 the deployer writes::

        plugins:
          messaging:
            bot_token_file: !secret telegram_bot_token

    and the config loader resolves the secret ref into an absolute
    file path before we get here.  We only need to read the file.
    """
    from hivemoot_agent.plugins_builtin.messaging.config import MessagingConfig
    cfg: MessagingConfig = config.typed
    if cfg is None or cfg.bot_token_file is None:
        return ""
    if not cfg.bot_token_file.is_file():
        return ""
    return cfg.bot_token_file.read_text().strip()


def _api_multipart(
    token: str,
    method: str,
    fields: dict[str, str],
    file_field: str,
    filename: str,
    content_type: str,
    content: bytes,
) -> dict:
    """Call a Telegram API method that requires multipart/form-data.

    Used for sendPhoto / sendDocument / sendVideo / sendAudio etc.  We
    avoid pulling in ``requests`` for one upload code path; stdlib
    multipart encoding is fiddly but small (~20 LOC) and zero-dep.
    """
    boundary = "----HivemootMessagingBoundary" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for k, v in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
        )
        chunks.append(str(v).encode("utf-8"))
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}\r\n".encode())
    # Telegram is fine with quoted ASCII filenames; we don't attempt
    # RFC 2231 encoding for non-ASCII.  If the agent picks a Unicode
    # filename, ASCII-encode with backslash-replacement so the upload
    # still goes through with a slightly mangled visible name.
    safe_filename = filename.encode("ascii", "backslashreplace").decode("ascii")
    chunks.append(
        f'Content-Disposition: form-data; name="{file_field}"; '
        f'filename="{safe_filename}"\r\n'.encode()
    )
    chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode())
    chunks.append(content)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())

    body = b"".join(chunks)
    url = f"https://api.telegram.org/bot{token}/{method}"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Content-Length", str(len(body)))

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print("telegram: token invalid (HTTP 401)", file=sys.stderr)
            raise
        # Surface Telegram's structured error payload so the caller
        # (CLI subcommand) can give the agent an actionable message.
        desc = _http_error_description(exc)
        if desc:
            print(f"telegram: upload failed ({exc.code}): {desc}", file=sys.stderr)
        raise


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


def _extract_attachment_hint(msg: dict) -> dict | None:
    """Pluck the first attachment from a Telegram message dict.

    Returns a dict with enough metadata for the trigger to name the
    downloaded file sensibly, or ``None`` if the message is pure text.
    Order of precedence matches ``_MEDIA_FIELDS``.

    Telegram's schema varies by kind — photos are an array of sizes
    (we pick the largest), documents carry a user-provided file_name,
    voice messages have no name so we synthesize one.  The hint is
    deliberately small; full download happens later in the trigger.
    """
    for kind in _MEDIA_FIELDS:
        value = msg.get(kind)
        if not value:
            continue

        if kind == "photo":
            # photo is a list of size variants; take the largest
            # (Telegram sorts smallest-first so we want the last).
            if not isinstance(value, list) or not value:
                continue
            largest = max(value, key=lambda p: p.get("file_size", 0) or 0)
            return {
                "kind": "photo",
                "file_id": largest.get("file_id", ""),
                "filename": "photo.jpg",
                "size_hint": int(largest.get("file_size", 0) or 0),
                "mime_hint": "image/jpeg",
                "dimensions": {
                    "width": largest.get("width"),
                    "height": largest.get("height"),
                },
            }

        if kind == "document":
            return {
                "kind": "document",
                "file_id": value.get("file_id", ""),
                "filename": value.get("file_name", "document"),
                "size_hint": int(value.get("file_size", 0) or 0),
                "mime_hint": value.get("mime_type", "application/octet-stream"),
            }

        if kind == "audio":
            title = value.get("title") or value.get("performer") or "audio"
            ext = mimetypes.guess_extension(value.get("mime_type", "")) or ".mp3"
            return {
                "kind": "audio",
                "file_id": value.get("file_id", ""),
                "filename": value.get("file_name") or f"{title}{ext}",
                "size_hint": int(value.get("file_size", 0) or 0),
                "mime_hint": value.get("mime_type", "audio/mpeg"),
                "duration_secs": value.get("duration", 0),
            }

        if kind == "voice":
            return {
                "kind": "voice",
                "file_id": value.get("file_id", ""),
                "filename": "voice.ogg",
                "size_hint": int(value.get("file_size", 0) or 0),
                "mime_hint": value.get("mime_type", "audio/ogg"),
                "duration_secs": value.get("duration", 0),
            }

        if kind == "video":
            ext = mimetypes.guess_extension(value.get("mime_type", "")) or ".mp4"
            return {
                "kind": "video",
                "file_id": value.get("file_id", ""),
                "filename": value.get("file_name") or f"video{ext}",
                "size_hint": int(value.get("file_size", 0) or 0),
                "mime_hint": value.get("mime_type", "video/mp4"),
                "dimensions": {
                    "width": value.get("width"),
                    "height": value.get("height"),
                },
                "duration_secs": value.get("duration", 0),
            }

    return None


# ── Adapter ────────────────────────────────────────────────────────


class TelegramAdapter:
    """Telegram Bot API adapter."""

    name = "telegram"

    def validate_config(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        token = _resolve_token(config)
        if not token:
            errors.append(
                "plugins.messaging.bot_token_file is required and must "
                "point at a readable file containing the Telegram bot token "
                "(typically `!secret telegram_bot_token`)"
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
        self, config: PluginConfig, offset: int, timeout: int = 30,
        strict: bool = False,
    ) -> list[dict]:
        """Long-poll getUpdates.  Returns normalized message dicts.

        strict=False (default) swallows network/API errors and returns [],
        which the daemon-mode trigger relies on — the in-process engine
        restarts the trigger on its own.  strict=True re-raises, which
        the host-side CLI uses so the shell watcher's exponential
        backoff engages instead of silent spinning.
        """
        token = _resolve_token(config)
        if not token:
            if strict:
                raise RuntimeError("messaging token is not configured")
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
            if strict:
                raise
            return []

        if not resp.get("ok"):
            if strict:
                raise RuntimeError(
                    f"telegram getUpdates returned not-ok: {resp.get('description', '')}"
                )
            return []

        messages: list[dict] = []
        for update in resp.get("result", []):
            update_id = update.get("update_id", 0)
            msg = update.get("message", {})
            chat_id = str(msg.get("chat", {}).get("id", ""))
            username = msg.get("from", {}).get("username", "unknown")
            # Text + caption are both user-typed content; unify them so
            # the trigger sees a caption on a photo the same way as a
            # plain text message.  When both are present (rare) we
            # concatenate with a blank line separator.
            text = msg.get("text", "")
            caption = msg.get("caption", "")
            if text and caption:
                combined_text = f"{text}\n\n{caption}"
            else:
                combined_text = text or caption

            attachment = _extract_attachment_hint(msg)

            messages.append({
                "update_id": update_id,
                "chat_id": chat_id,
                "username": username,
                "text": combined_text,
                # attachment is None when the message is pure text, or a
                # dict {kind, file_id, filename, size_hint, mime_hint}
                # that the trigger resolves into an actual downloaded
                # file before dispatching.
                "attachment": attachment,
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

    def send_file(
        self,
        config: PluginConfig,
        chat_id: str,
        file_path: str,
        *,
        caption: str = "",
        as_document: bool = False,
    ) -> dict:
        """Upload a local file to a Telegram chat.

        Auto-routes by file extension: image extensions go to
        ``sendPhoto`` (Telegram inline-previews them); everything
        else goes to ``sendDocument`` (preserves original filename
        and bytes).  ``as_document=True`` forces sendDocument even
        for images.

        Returns a dict with ``{"ok": bool, ...}`` — on success the
        Telegram API ``result`` is included; on failure the
        ``error`` and ``message`` keys explain why.  Designed for
        a CLI caller that prints the dict as JSON for the agent.
        """
        token = _resolve_token(config)
        if not token:
            return {"ok": False, "error": "no_token", "message": "TELEGRAM_BOT_TOKEN(_FILE) not configured"}

        path = Path(file_path)
        if not path.is_file():
            return {"ok": False, "error": "file_not_found", "message": f"no file at {file_path}"}

        ext = path.suffix.lower()
        size = path.stat().st_size

        # Route by extension unless caller forced document mode.
        use_photo = (not as_document) and (ext in _PHOTO_EXTENSIONS)
        method = "sendPhoto" if use_photo else "sendDocument"
        file_field = "photo" if use_photo else "document"
        cap = _TELEGRAM_PHOTO_MAX_BYTES if use_photo else _TELEGRAM_DOCUMENT_MAX_BYTES
        if size > cap:
            return {
                "ok": False,
                "error": "file_too_large",
                "message": (
                    f"{file_path} is {size} bytes; Telegram bot {method} cap is {cap}.  "
                    "For >10MB images, retry with as_document=True (50MB cap)."
                ),
                "size_bytes": size,
                "max_bytes": cap,
            }

        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"

        try:
            content = path.read_bytes()
        except OSError as exc:
            return {"ok": False, "error": "read_failed", "message": str(exc)}

        fields = {"chat_id": chat_id}
        if caption:
            # Telegram caps captions at 1024 chars.  Trim quietly with
            # a single-line note rather than failing the upload.
            if len(caption) > 1024:
                caption = caption[:1020] + " […]"
            fields["caption"] = caption

        try:
            resp = _api_multipart(
                token, method, fields, file_field,
                path.name, content_type, content,
            )
        except urllib.error.HTTPError as exc:
            return {
                "ok": False,
                "error": "http_error",
                "code": exc.code,
                "message": _http_error_description(exc) or str(exc),
            }
        except Exception as exc:
            return {"ok": False, "error": "upload_error", "message": str(exc)}

        if not resp.get("ok"):
            return {
                "ok": False,
                "error": "telegram_rejected",
                "message": resp.get("description", ""),
            }
        return {
            "ok": True,
            "method": method,
            "filename": path.name,
            "size_bytes": size,
            "message_id": resp.get("result", {}).get("message_id"),
        }

    def download_file(
        self,
        config: PluginConfig,
        file_id: str,
        dest_path: str,
    ) -> dict:
        """Download a Telegram-hosted file to ``dest_path``.

        Two-step: ``getFile`` resolves the file_id to a server-side
        path + size, then HTTPS GET against
        ``https://api.telegram.org/file/bot<TOKEN>/<file_path>``.
        Bot API caps file size at 20MB — files larger than this need
        MTProto and are rejected with ``file_too_large``.

        Returns ``{"ok": True, "path": ..., "size_bytes": ..., "mime": ...}``
        on success; ``{"ok": False, "error": ..., "message": ...}`` on
        failure.  Callers use the structured shape to compose a
        user-visible explanation when needed.
        """
        token = _resolve_token(config)
        if not token:
            return {"ok": False, "error": "no_token", "message": "TELEGRAM_BOT_TOKEN(_FILE) not configured"}

        # getFile: resolve file_id → server-side file_path + expected size.
        try:
            resp = _api(token, "getFile", {"file_id": file_id})
        except urllib.error.HTTPError as exc:
            return {
                "ok": False,
                "error": "get_file_http",
                "code": exc.code,
                "message": _http_error_description(exc) or str(exc),
            }
        except Exception as exc:
            return {"ok": False, "error": "get_file_error", "message": str(exc)}

        if not resp.get("ok"):
            return {
                "ok": False,
                "error": "get_file_rejected",
                "message": resp.get("description", ""),
            }
        result = resp.get("result", {})
        file_path = result.get("file_path", "")
        size = int(result.get("file_size", 0) or 0)
        if not file_path:
            return {"ok": False, "error": "no_file_path", "message": "Telegram response missing file_path"}
        if size and size > _TELEGRAM_DOWNLOAD_MAX_BYTES:
            return {
                "ok": False,
                "error": "file_too_large",
                "message": (
                    f"{size} bytes exceeds Telegram bot API's 20MB download cap.  "
                    "Larger files need MTProto (not supported)."
                ),
                "size_bytes": size,
                "max_bytes": _TELEGRAM_DOWNLOAD_MAX_BYTES,
            }

        # Stream the download to disk so we don't hold the whole file
        # in memory for large documents / videos near the 20MB cap.
        download_url = f"https://api.telegram.org/file/bot{token}/{file_path}"
        try:
            Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(download_url, timeout=120) as resp_stream:
                with open(dest_path, "wb") as fh:
                    while True:
                        chunk = resp_stream.read(65536)
                        if not chunk:
                            break
                        fh.write(chunk)
        except urllib.error.HTTPError as exc:
            return {
                "ok": False,
                "error": "download_http",
                "code": exc.code,
                "message": str(exc),
            }
        except Exception as exc:
            return {"ok": False, "error": "download_error", "message": str(exc)}

        actual_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
        content_type, _ = mimetypes.guess_type(file_path)
        return {
            "ok": True,
            "path": dest_path,
            "size_bytes": actual_size,
            "mime": content_type or "application/octet-stream",
            "telegram_file_path": file_path,
        }

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
