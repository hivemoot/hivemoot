"""Host-side messaging CLI — preflight, watch, send.

Used by the controller (`controller/triggers/messaging.sh` and
`controller/main.sh`) to delegate platform I/O to Python instead of
maintaining a parallel shell adapter.  The in-container daemon mode
does not use this — it runs the MessagingTrigger directly inside the
engine loop.

Commands:
    hivemoot-agent messaging preflight --platform telegram
        Exits 0 if credentials and deps look healthy; 1 otherwise.
        Surfaces validation messages on stderr.

    hivemoot-agent messaging watch --platform telegram \\
                                   --offset-file PATH \\
                                   [--poll-timeout 30]
        Long-running.  Emits one NDJSON object per message on stdout:
            {"update_id": N, "chat_id": "...",
             "username": "...", "text": "..."}
        Owns the offset file: reads on start, writes after each
        emit.  Exits non-zero on API error so the shell watcher's
        backoff engages.

    hivemoot-agent messaging send --platform telegram --chat-id ID
        Reads text from stdin and sends it.  Used by the controller's
        busy-ack path.  Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from hivemoot_agent.plugins.interfaces import PluginConfig


# ── Argparse wiring ────────────────────────────────────────────────


def register_messaging_commands(
    subparsers: argparse._SubParsersAction,
) -> None:
    """Register the `messaging` subcommand group on the root parser."""
    mp = subparsers.add_parser(
        "messaging",
        help="Messaging platform utilities (host-side)",
    )
    msub = mp.add_subparsers(dest="messaging_command")

    pre = msub.add_parser(
        "preflight",
        help="Validate credentials and check dependencies",
    )
    pre.add_argument("--platform", default="telegram")
    pre.set_defaults(func=cmd_preflight)

    watch = msub.add_parser(
        "watch",
        help="Long-poll the platform and emit NDJSON on stdout",
    )
    watch.add_argument("--platform", default="telegram")
    watch.add_argument("--offset-file", required=True)
    watch.add_argument("--poll-timeout", type=int, default=30)
    watch.set_defaults(func=cmd_watch)

    send = msub.add_parser(
        "send",
        help="Send a message; text read from stdin",
    )
    send.add_argument("--platform", default="telegram")
    send.add_argument("--chat-id", required=True)
    send.set_defaults(func=cmd_send)


# ── Adapter resolution ─────────────────────────────────────────────


def _load_adapter(platform: str) -> Any:
    """Resolve a platform name to its adapter instance."""
    if platform == "telegram":
        from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import (
            TelegramAdapter,
        )

        return TelegramAdapter()
    return None


def _build_config(platform: str) -> PluginConfig:
    """Build a PluginConfig from env for the host-side CLI.

    The adapter resolves TELEGRAM_BOT_TOKEN / _FILE from either the
    settings dict or os.environ, so we only need to surface the
    platform name here.  Keeping settings minimal avoids duplicating
    the engine's config-loading logic for a pure-CLI path.
    """
    return PluginConfig(
        name="messaging",
        settings={"MESSAGING_PLATFORM": platform},
    )


# ── preflight ──────────────────────────────────────────────────────


def cmd_preflight(args: argparse.Namespace) -> int:
    adapter = _load_adapter(args.platform)
    if adapter is None:
        print(
            f"messaging preflight: unknown platform '{args.platform}'",
            file=sys.stderr,
        )
        return 1

    config = _build_config(args.platform)
    errors = adapter.validate_config(config)
    if errors:
        for err in errors:
            print(f"messaging preflight: {err}", file=sys.stderr)
        return 1
    return 0


# ── watch ──────────────────────────────────────────────────────────


def _read_offset(path: str) -> int:
    """Read the stored offset, returning 0 if missing or invalid."""
    try:
        with open(path) as f:
            return int(f.read().strip() or "0")
    except (FileNotFoundError, ValueError):
        return 0


def _write_offset(path: str, offset: int) -> None:
    """Persist the offset atomically (temp+rename)."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        f.write(str(offset))
    os.replace(tmp_path, path)


def cmd_watch(args: argparse.Namespace) -> int:
    adapter = _load_adapter(args.platform)
    if adapter is None:
        print(
            f"messaging watch: unknown platform '{args.platform}'",
            file=sys.stderr,
        )
        return 1

    config = _build_config(args.platform)
    offset = _read_offset(args.offset_file)
    print(
        f"messaging watch: starting "
        f"(platform={args.platform} offset={offset} "
        f"timeout={args.poll_timeout}s)",
        file=sys.stderr,
        flush=True,
    )

    while True:
        try:
            messages = adapter.poll(
                config, offset, args.poll_timeout, strict=True,
            )
        except Exception as exc:
            print(f"messaging watch: poll error: {exc}", file=sys.stderr, flush=True)
            return 1

        for msg in messages:
            update_id = msg.get("update_id", 0)
            chat_id = msg.get("chat_id", "")
            text = msg.get("text", "")

            # Empty text or non-chat updates are not actionable; the
            # shell's messaging_dispatch_update would drop them anyway.
            # We still advance the offset so we never re-poll them.
            if text and chat_id:
                line = json.dumps({
                    "update_id": update_id,
                    "chat_id": chat_id,
                    "username": msg.get("username", "unknown"),
                    "text": text,
                })
                print(line, flush=True)

            offset = max(offset, update_id + 1)
            _write_offset(args.offset_file, offset)


# ── send ───────────────────────────────────────────────────────────


def cmd_send(args: argparse.Namespace) -> int:
    adapter = _load_adapter(args.platform)
    if adapter is None:
        print(
            f"messaging send: unknown platform '{args.platform}'",
            file=sys.stderr,
        )
        return 1

    text = sys.stdin.read()
    if not text:
        print("messaging send: empty stdin", file=sys.stderr)
        return 1

    config = _build_config(args.platform)
    ok = adapter.send(config, args.chat_id, text)
    return 0 if ok else 1
