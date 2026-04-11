#!/usr/bin/env python3
"""hivemoot-agent CLI entry point.

Usage:
    hivemoot-agent messaging poll   --platform telegram --token-file TOKEN_FILE
    hivemoot-agent messaging send   --platform telegram --token-file TOKEN_FILE --chat-id ID --text TEXT
    hivemoot-agent messaging typing --platform telegram --token-file TOKEN_FILE --chat-id ID
    hivemoot-agent extract response --provider claude --log-file LOG
    hivemoot-agent doctor
"""

import argparse
import sys

from hivemoot_agent.messaging.commands import register_messaging_commands
from hivemoot_agent.extract.commands import register_extract_commands


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hivemoot-agent",
        description="Hivemoot agent runtime CLI",
    )
    parser.add_argument(
        "--version", action="store_true", help="Show version and exit"
    )

    sub = parser.add_subparsers(dest="command")

    register_messaging_commands(sub)
    register_extract_commands(sub)

    # doctor
    doctor = sub.add_parser("doctor", help="Health check — validate config, tokens, Docker")
    doctor.set_defaults(func=_cmd_doctor)

    return parser


def _cmd_doctor(args: argparse.Namespace) -> int:
    """Basic health check."""
    import shutil

    checks = [
        ("docker", shutil.which("docker")),
        ("jq", shutil.which("jq")),
        ("curl", shutil.which("curl")),
    ]
    ok = True
    for name, path in checks:
        if path:
            print(f"  \u2713 {name}: {path}")
        else:
            print(f"  \u2717 {name}: not found", file=sys.stderr)
            ok = False
    return 0 if ok else 1


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.version:
        from hivemoot_agent import __version__

        print(f"hivemoot-agent {__version__}")
        return 0

    if not args.command:
        parser.print_help()
        return 0

    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 0

    return func(args)


if __name__ == "__main__":
    sys.exit(main())
