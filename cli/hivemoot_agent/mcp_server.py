"""Hivemoot MCP server — exposes plugin tools to the agent.

Runs as a subprocess started by Claude Code.  Communicates via
JSON-RPC over stdin/stdout (MCP protocol).  Tools are registered
from active plugins.

Usage (called by the engine, not directly):
    python3 mcp_server.py --plugin messaging --config '{"TELEGRAM_BOT_TOKEN": "...", "chat_id": "538808751"}'
"""

from __future__ import annotations

import json
import sys
import os
from typing import Any

# Ensure the CLI package is importable — the MCP server runs as a
# subprocess started by Claude Code, which doesn't set PYTHONPATH.
_cli_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _cli_dir not in sys.path:
    sys.path.insert(0, _cli_dir)


# ── MCP Protocol (minimal implementation) ──────────────────────────

def _read_message() -> dict | None:
    """Read a JSON-RPC message from stdin."""
    try:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line.strip())
    except (json.JSONDecodeError, EOFError):
        return None


def _write_message(msg: dict) -> None:
    """Write a JSON-RPC message to stdout."""
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _response(id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _error(id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


# ── Tool registry ──────────────────────────────────────────────────

class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, dict] = {}
        self._handlers: dict[str, Any] = {}

    def register(
        self,
        name: str,
        description: str,
        parameters: dict,
        handler: Any,
        required: list[str] | None = None,
        annotations: dict | None = None,
    ) -> None:
        tool: dict[str, Any] = {
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": parameters,
            },
        }
        if required:
            tool["inputSchema"]["required"] = required
        if annotations:
            tool["annotations"] = annotations
        self._tools[name] = tool
        self._handlers[name] = handler

    def list_tools(self) -> list[dict]:
        return list(self._tools.values())

    def call_tool(self, name: str, arguments: dict) -> Any:
        handler = self._handlers.get(name)
        if handler is None:
            raise ValueError(f"Unknown tool: {name}")
        return handler(arguments)


# ── Messaging tools ────────────────────────────────────────────────

def _build_messaging_tools(registry: ToolRegistry, config: dict) -> None:
    """Register messaging tools (send_message, send_file)."""
    import urllib.parse
    import urllib.request
    import urllib.error

    token = config.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        token_file = config.get("TELEGRAM_BOT_TOKEN_FILE", "")
        if token_file and os.path.isfile(token_file):
            with open(token_file) as f:
                token = f.read().strip()

    chat_id = config.get("chat_id", "")

    def _telegram_api(method: str, data: dict) -> dict:
        url = f"https://api.telegram.org/bot{token}/{method}"
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    def _telegram_upload(method: str, field: str, path: str, extra: dict) -> dict:
        """Upload a file via multipart form."""
        import mimetypes
        boundary = "----HivemootMCPBoundary"
        filename = os.path.basename(path)
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"

        with open(path, "rb") as f:
            file_data = f.read()

        body = b""
        # Add extra fields.
        for key, val in extra.items():
            body += f"--{boundary}\r\n".encode()
            body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
            body += f"{val}\r\n".encode()
        # Add file field.
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode()
        body += f"Content-Type: {mime}\r\n\r\n".encode()
        body += file_data
        body += f"\r\n--{boundary}--\r\n".encode()

        url = f"https://api.telegram.org/bot{token}/{method}"
        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())

    def _detect_send_method(path: str) -> tuple[str, str]:
        """Detect the Telegram API method and field name from file extension."""
        ext = os.path.splitext(path)[1].lower()
        image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
        audio_exts = {".mp3", ".wav", ".flac", ".aac", ".m4a"}
        voice_exts = {".ogg", ".oga"}
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

        if ext in image_exts:
            return "sendPhoto", "photo"
        if ext in voice_exts:
            return "sendVoice", "voice"
        if ext in audio_exts:
            return "sendAudio", "audio"
        if ext in video_exts:
            return "sendVideo", "video"
        return "sendDocument", "document"

    # ── Tool: send_message ─────────────────────────────────────────

    def _send_html(target: str, text: str) -> dict:
        """Send HTML message, fallback to plain text. Returns API response."""
        from hivemoot_agent.plugins_builtin.messaging.formatter import (
            markdown_to_telegram_html,
        )
        html = markdown_to_telegram_html(text)
        try:
            resp = _telegram_api("sendMessage", {
                "chat_id": target,
                "text": html,
                "parse_mode": "HTML",
            })
            if resp.get("ok"):
                return resp
            # Fallback to plain text.
            return _telegram_api("sendMessage", {"chat_id": target, "text": text})
        except Exception:
            return _telegram_api("sendMessage", {"chat_id": target, "text": text})

    def handle_send_message(args: dict) -> str:
        text = args.get("text", "")
        target = args.get("chat_id", chat_id)
        if not text:
            return "Error: text is required"
        try:
            resp = _send_html(target, text)
            msg_id = resp.get("result", {}).get("message_id", "")
            return f"Message sent (message_id={msg_id})"
        except Exception as exc:
            return f"Error sending message: {exc}"

    registry.register(
        name="send_message",
        description=(
            "Send a message to the user via the messaging platform. "
            "This is the PRIMARY way to communicate — use it for all "
            "responses, status updates, questions, and results. "
            "Do NOT print to console; the user only sees messages sent "
            "through this tool. Supports Markdown: **bold**, *italic*, "
            "`code`, ```code blocks```, [links](url). "
            "Returns the message_id for use with edit_message."
        ),
        parameters={
            "text": {
                "type": "string",
                "description": "Message content. Supports Markdown formatting.",
            },
        },
        required=["text"],
        annotations={"readOnlyHint": False, "idempotentHint": False},
        handler=handle_send_message,
    )

    # ── Tool: edit_message ─────────────────────────────────────────

    def handle_edit_message(args: dict) -> str:
        message_id = args.get("message_id", "")
        text = args.get("text", "")
        target = args.get("chat_id", chat_id)
        if not message_id:
            return "Error: message_id is required"
        if not text:
            return "Error: text is required"

        from hivemoot_agent.plugins_builtin.messaging.formatter import (
            markdown_to_telegram_html,
        )
        html = markdown_to_telegram_html(text)

        try:
            resp = _telegram_api("editMessageText", {
                "chat_id": target,
                "message_id": message_id,
                "text": html,
                "parse_mode": "HTML",
            })
            if resp.get("ok"):
                return "Message edited"
            # Fallback to plain text.
            resp = _telegram_api("editMessageText", {
                "chat_id": target,
                "message_id": message_id,
                "text": text,
            })
            if resp.get("ok"):
                return "Message edited (plain text fallback)"
            return f"Error: {resp.get('description', 'unknown')}"
        except Exception as exc:
            return f"Error editing message: {exc}"

    registry.register(
        name="edit_message",
        description=(
            "Edit a previously sent message. Use the message_id returned "
            "by send_message. Useful for updating a status message or "
            "correcting a response. If the message_id is invalid, returns "
            "an error."
        ),
        parameters={
            "message_id": {
                "type": "string",
                "description": "The message_id returned by a previous send_message call.",
            },
            "text": {
                "type": "string",
                "description": "New message content (replaces the entire message). Markdown supported.",
            },
        },
        required=["message_id", "text"],
        annotations={"readOnlyHint": False, "idempotentHint": True},
        handler=handle_edit_message,
    )

    # ── Tool: send_file ────────────────────────────────────────────

    # Restrict file sends to /tmp only — workspace has logs, clones, state.
    _SAFE_DIRS = ("/tmp",)

    def handle_send_file(args: dict) -> str:
        path = args.get("path", "")
        caption = args.get("caption", "")
        target = args.get("chat_id", chat_id)
        if not path:
            return "Error: path is required"

        # Security: only allow files from safe directories to prevent
        # exfiltration of secrets, auth files, or system files.
        real_path = os.path.realpath(path)
        if not any(real_path.startswith(d + "/") for d in _SAFE_DIRS):
            return (
                f"Error: file path must be under {' or '.join(_SAFE_DIRS)}. "
                f"Got: {path}"
            )

        if not os.path.isfile(real_path):
            return f"Error: file not found: {path}"

        method, field = _detect_send_method(path)
        extra = {"chat_id": target}
        if caption:
            extra["caption"] = caption

        try:
            resp = _telegram_upload(method, field, path, extra)
            if resp.get("ok"):
                return f"File sent via {method}"
            return f"Error: {resp.get('description', 'unknown')}"
        except Exception as exc:
            return f"Error sending file: {exc}"

    registry.register(
        name="send_file",
        description=(
            "Send a file to the user. Auto-detects type from extension: "
            ".png/.jpg → photo, .pdf → document, .ogg → voice, .mp4 → video. "
            "Use for sharing generated images, code files, reports, audio. "
            "Files must be under /tmp (security restriction)."
        ),
        parameters={
            "path": {
                "type": "string",
                "description": "Absolute path to the file to send.",
            },
            "caption": {
                "type": "string",
                "description": "Optional caption displayed with the file.",
            },
        },
        required=["path"],
        annotations={"readOnlyHint": True, "idempotentHint": False},
        handler=handle_send_file,
    )


# ── Main loop ──────────────────────────────────────────────────────

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin", required=True)
    parser.add_argument("--config", default="{}")
    args = parser.parse_args()

    config = json.loads(args.config)

    # Merge env vars into config.
    for key in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_FILE",
                "MESSAGING_PLATFORM", "MESSAGING_ALLOWED_CHAT_IDS"):
        if key in os.environ and key not in config:
            config[key] = os.environ[key]

    registry = ToolRegistry()

    if args.plugin == "messaging":
        _build_messaging_tools(registry, config)

    # MCP server loop.
    while True:
        msg = _read_message()
        if msg is None:
            break

        method = msg.get("method", "")
        id = msg.get("id")

        if method == "initialize":
            _write_message(_response(id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "messaging", "version": "0.1.0"},
            }))

        elif method == "notifications/initialized":
            pass  # No response needed.

        elif method == "tools/list":
            _write_message(_response(id, {"tools": registry.list_tools()}))

        elif method == "tools/call":
            params = msg.get("params", {})
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            try:
                result = registry.call_tool(tool_name, arguments)
                _write_message(_response(id, {
                    "content": [{"type": "text", "text": str(result)}],
                }))
            except Exception as exc:
                _write_message(_response(id, {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                }))

        elif id is not None:
            _write_message(_error(id, -32601, f"Unknown method: {method}"))


if __name__ == "__main__":
    main()
