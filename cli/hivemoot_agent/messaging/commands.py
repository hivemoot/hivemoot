"""CLI commands for messaging: poll, send, typing."""

from __future__ import annotations

import argparse
import json
import os
import sys


def _read_token(path: str) -> str:
    """Read a token from a file, stripping whitespace."""
    with open(path) as f:
        return f.read().strip()


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    """Add --platform and --token-file args shared by all messaging commands."""
    parser.add_argument(
        "--platform",
        default=os.environ.get("MESSAGING_PLATFORM", "telegram"),
        help="Platform adapter (default: telegram)",
    )
    parser.add_argument(
        "--token-file",
        default=os.environ.get("TELEGRAM_BOT_TOKEN_FILE", ""),
        help="Path to bot token file",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Bot token (prefer --token-file in production)",
    )


def _resolve_token(args: argparse.Namespace) -> str:
    """Resolve the bot token from args or env."""
    if args.token:
        return args.token
    if args.token_file:
        return _read_token(args.token_file)
    # Fallback to env var (for Telegram).
    env_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if env_token:
        return env_token
    print("No bot token provided (--token-file, --token, or TELEGRAM_BOT_TOKEN)", file=sys.stderr)
    raise SystemExit(1)


def register_messaging_commands(subparsers: argparse._SubParsersAction) -> None:
    """Register the 'messaging' command group."""
    msg = subparsers.add_parser("messaging", help="Messaging platform I/O")
    msg_sub = msg.add_subparsers(dest="messaging_command")

    # poll
    poll = msg_sub.add_parser(
        "poll",
        help="Long-poll for messages, output NDJSON events to stdout",
    )
    _add_common_args(poll)
    poll.add_argument(
        "--offset-file",
        default="",
        help="File to persist the poll offset across restarts",
    )
    poll.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Long-poll timeout in seconds (default: 30)",
    )
    poll.add_argument(
        "--allowed-chats",
        default=os.environ.get("MESSAGING_ALLOWED_CHAT_IDS", ""),
        help="Comma-separated allowed chat IDs (empty = deny all)",
    )
    poll.add_argument(
        "--once",
        action="store_true",
        help="Poll once and exit (for testing)",
    )
    poll.set_defaults(func=cmd_poll)

    # send
    send = msg_sub.add_parser("send", help="Send a text message")
    _add_common_args(send)
    send.add_argument("--chat-id", required=True, help="Target chat ID")
    send.add_argument("--text", default="", help="Message text (or read from stdin)")
    send.set_defaults(func=cmd_send)

    # typing
    typ = msg_sub.add_parser("typing", help="Send a typing indicator")
    _add_common_args(typ)
    typ.add_argument("--chat-id", required=True, help="Target chat ID")
    typ.set_defaults(func=cmd_typing)

    # validate
    val = msg_sub.add_parser("validate", help="Validate bot token")
    _add_common_args(val)
    val.set_defaults(func=cmd_validate)

    msg.set_defaults(func=lambda args: msg.print_help() or 0)


def cmd_poll(args: argparse.Namespace) -> int:
    """Long-poll for messages and output NDJSON events to stdout."""
    from hivemoot_agent.messaging.platforms import load_adapter

    adapter = load_adapter(args.platform)
    token = _resolve_token(args)

    allowed = set()
    if args.allowed_chats:
        allowed = {c.strip() for c in args.allowed_chats.split(",") if c.strip()}

    offset = 0
    if args.offset_file and os.path.isfile(args.offset_file):
        try:
            offset = int(open(args.offset_file).read().strip())
        except (ValueError, OSError):
            pass

    while True:
        messages = adapter.poll(token, offset, args.timeout)
        if not messages:
            if args.once:
                break
            continue

        for msg in messages:
            update_id = msg.get("update_id", 0)
            chat_id = msg.get("chat_id", "")
            text = msg.get("text", "")

            # Always advance offset.
            new_offset = update_id + 1
            if new_offset > offset:
                offset = new_offset

            # Filter: skip empty text.
            if not text or not chat_id:
                continue

            # Filter: access control.
            if not allowed or chat_id not in allowed:
                print(
                    json.dumps({"type": "denied", "chat_id": chat_id}),
                    file=sys.stderr,
                )
                continue

            # Emit NDJSON event.
            event = {
                "type": "message",
                "chat_id": chat_id,
                "username": msg.get("username", "unknown"),
                "text": text,
                "session_key": msg.get("session_key", ""),
                "ack_key": msg.get("ack_key", ""),
            }
            print(json.dumps(event, ensure_ascii=False), flush=True)

        # Persist offset after processing the batch.
        if args.offset_file:
            tmp = args.offset_file + ".tmp"
            try:
                with open(tmp, "w") as f:
                    f.write(str(offset))
                os.replace(tmp, args.offset_file)
            except OSError as exc:
                print(f"warning: failed to write offset file: {exc}", file=sys.stderr)

        if args.once:
            break

    return 0


def cmd_send(args: argparse.Namespace) -> int:
    """Send a text message to a chat."""
    from hivemoot_agent.messaging.platforms import load_adapter

    adapter = load_adapter(args.platform)
    token = _resolve_token(args)

    text = args.text
    if not text:
        # Read from stdin.
        text = sys.stdin.read()
    if not text:
        print("No text to send (--text or stdin)", file=sys.stderr)
        return 1

    ok = adapter.send(token, args.chat_id, text)
    return 0 if ok else 1


def cmd_typing(args: argparse.Namespace) -> int:
    """Send a typing indicator to a chat."""
    from hivemoot_agent.messaging.platforms import load_adapter

    adapter = load_adapter(args.platform)
    token = _resolve_token(args)
    ok = adapter.typing(token, args.chat_id)
    return 0 if ok else 1


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate the bot token."""
    from hivemoot_agent.messaging.platforms import load_adapter

    adapter = load_adapter(args.platform)
    token = _resolve_token(args)
    ok = adapter.validate_token(token)
    return 0 if ok else 1
