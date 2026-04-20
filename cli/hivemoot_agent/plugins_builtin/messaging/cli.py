"""messaging plugin CLI — agents call to send attachments back to the chat.

Usage (from inside a messaging-running agent container):

    python3 -m hivemoot_agent.plugins_builtin.messaging.cli \\
        send-file /path/to/screenshot.png --caption "weather.com snapshot"

The CLI reads ``/tmp/.messaging-job-context.json`` (written by the
messaging plugin's ``on_job_started`` lifecycle hook) to find the
active chat_id and platform, then dispatches to the appropriate
platform adapter.  The plugin's text-reply path remains the agent's
final-response channel; this CLI is for **mid-job** attachments
(images, PDFs, logs, anything binary).

Auto-routes by file extension on Telegram: images → ``sendPhoto``
(inline preview), everything else → ``sendDocument`` (preserves
filename + bytes).  ``--as-document`` overrides to always use
sendDocument.

Output is JSON on stdout (success) or stderr (error) with a
non-zero exit so the agent can branch on outcome.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from hivemoot_agent.plugins.interfaces import PluginConfig


_JOB_CONTEXT_PATH = Path("/tmp/.messaging-job-context.json")


def _err(payload: dict, exit_code: int = 1) -> None:
    print(json.dumps(payload), file=sys.stderr, flush=True)
    sys.exit(exit_code)


def _load_context() -> dict:
    """Read the active job context written by on_job_started.

    Falls back to env-var overrides so an operator can invoke the CLI
    out-of-band (e.g. for testing) without going through the trigger.
    """
    if _JOB_CONTEXT_PATH.is_file():
        try:
            return json.loads(_JOB_CONTEXT_PATH.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            _err({
                "error": "context_unreadable",
                "path": str(_JOB_CONTEXT_PATH),
                "message": str(exc),
            })
    chat_id = os.environ.get("MESSAGING_CHAT_ID", "").strip()
    platform = os.environ.get("MESSAGING_PLATFORM", "").strip()
    if chat_id and platform:
        return {"chat_id": chat_id, "platform": platform}
    _err({
        "error": "no_active_context",
        "message": (
            "No messaging job context found.  This CLI must be invoked from "
            "inside a job dispatched by the messaging plugin (chat_id is "
            "populated automatically), or with MESSAGING_CHAT_ID + "
            "MESSAGING_PLATFORM env vars set explicitly."
        ),
    })
    return {}  # unreachable, _err exits


def _config_from_env() -> PluginConfig:
    """Build a PluginConfig from the current process env.

    The platform adapter reads token / endpoint settings from this; we
    can't import the live registry instance here because the CLI runs
    in its own subprocess separate from the engine.
    """
    return PluginConfig(name="messaging", settings=dict(os.environ))


def _send_file(args: argparse.Namespace) -> None:
    ctx = _load_context()
    chat_id = ctx.get("chat_id", "")
    platform = ctx.get("platform", "")

    if not chat_id:
        _err({"error": "missing_chat_id", "message": "context lacks chat_id"})

    if platform == "telegram":
        from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import (
            TelegramAdapter,
        )
        adapter = TelegramAdapter()
        result = adapter.send_file(
            _config_from_env(),
            chat_id,
            args.path,
            caption=args.caption or "",
            as_document=args.as_document,
        )
    else:
        _err({
            "error": "unsupported_platform",
            "platform": platform,
            "message": (
                f"Platform '{platform}' has no send-file support yet.  "
                "Currently only telegram is wired."
            ),
        })
        return  # unreachable, _err exits

    if not result.get("ok"):
        _err(result)
    print(json.dumps(result))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hivemoot-agent.messaging",
        description="Send attachments back to the active messaging chat.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    send = sub.add_parser(
        "send-file",
        help="Upload a local file as an attachment to the active chat",
    )
    send.add_argument("path", help="Local file path to upload")
    send.add_argument(
        "--caption",
        default="",
        help="Optional caption (Telegram caps at 1024 chars; longer is trimmed)",
    )
    send.add_argument(
        "--as-document",
        action="store_true",
        default=False,
        help=(
            "Force sendDocument even for image extensions.  Use to "
            "preserve original quality (no Telegram recompression) "
            "or to send screenshots as files instead of inline previews."
        ),
    )

    return parser


def main() -> int:
    args = _build_parser().parse_args()
    handler = {"send-file": _send_file}[args.cmd]
    handler(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
