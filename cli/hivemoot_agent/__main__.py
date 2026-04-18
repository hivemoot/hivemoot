#!/usr/bin/env python3
"""hivemoot-agent CLI.

Commands:
    hivemoot-agent run                Daemon mode (triggers poll continuously)
    hivemoot-agent oneshot            Run agent once and exit
    hivemoot-agent plugin list        List available plugins
    hivemoot-agent plugin doctor X    Validate a plugin's config
    hivemoot-agent messaging ...      Host-side messaging utilities
    hivemoot-agent health ...         Host-side health reporting
    hivemoot-agent doctor             Health check
"""

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hivemoot-agent",
        description="Hivemoot agent runtime",
    )
    parser.add_argument(
        "--version", action="store_true", help="Show version and exit"
    )

    sub = parser.add_subparsers(dest="command")

    # run — daemon mode
    sub.add_parser(
        "run", help="Start the engine (daemon — triggers poll continuously)"
    ).set_defaults(func=_cmd_run)

    # oneshot — run once and exit
    oneshot = sub.add_parser(
        "oneshot", help="Run the agent once and exit"
    )
    oneshot.add_argument(
        "--prompt", default="",
        help="User prompt (or AGENT_EXTRA_PROMPT env var)",
    )
    oneshot.set_defaults(func=_cmd_oneshot)

    # plugin
    from hivemoot_agent.plugins.commands import register_plugin_commands
    register_plugin_commands(sub)

    # messaging — host-side platform utilities (preflight, watch, send)
    from hivemoot_agent.plugins_builtin.messaging.cli import (
        register_messaging_commands,
    )
    register_messaging_commands(sub)

    # health — host-side reporting (heartbeat)
    from hivemoot_agent.health import register_health_commands
    register_health_commands(sub)

    # doctor
    sub.add_parser("doctor", help="Health check").set_defaults(func=_cmd_doctor)

    return parser


def _cmd_run(args: argparse.Namespace) -> int:
    from hivemoot_agent.engine import Engine
    return Engine().run()


def _cmd_oneshot(args: argparse.Namespace) -> int:
    from hivemoot_agent.engine import Engine
    return Engine().oneshot(prompt=args.prompt or None)


def _cmd_doctor(args: argparse.Namespace) -> int:
    import shutil
    checks = [
        ("claude", shutil.which("claude")),
        ("python3", shutil.which("python3")),
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

    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 0

    return func(args)


if __name__ == "__main__":
    sys.exit(main())
