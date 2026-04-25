"""apiarist CLI entry point.

Phase B wires up config loading + structured logging. The asyncio UDS
server (Phase D), backend client (Phase C), and feature plugins
(Phase E onward) replace the scaffold-mode branch below as they land.
The full design lives in DESIGN.md.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import structlog

from apiarist.config import ConfigError, load_config
from apiarist.logging import configure_logging
from apiarist.version import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="apiarist",
        description=(
            "Host-side daemon for the Hivemoot fleet. "
            "Brokers GitHub installation tokens for local agent containers; "
            "future phases add dynamic agent spawning. "
            "See DESIGN.md for architecture."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"apiarist {__version__}",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Path to apiarist.yaml "
            "(default: /etc/apiarist/apiarist.yaml if it exists)"
        ),
    )
    # CLI overrides for individual config fields. All default to None so
    # `load_config` can tell "not set on CLI" from "set to a value" and
    # only override env/file when explicitly provided.
    parser.add_argument("--socket-path", type=Path, default=None)
    parser.add_argument("--socket-group", default=None)
    parser.add_argument("--backend-url", default=None)
    parser.add_argument(
        "--log-level",
        default=None,
        choices=["debug", "info", "warning", "error", "critical"],
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    cli_overlay = {
        "socket_path": args.socket_path,
        "socket_group": args.socket_group,
        "backend_url": args.backend_url,
        "log_level": args.log_level,
    }

    try:
        config = load_config(
            cli_overlay=cli_overlay,
            env=dict(os.environ),
            config_path=args.config,
        )
    except ConfigError as exc:
        # Config errors happen before logging is configured, so emit
        # plain stderr rather than a structured log line. Exit 1 so
        # systemd surfaces the failure rather than treating an empty
        # daemon as a successful start.
        print(f"apiarist: config error: {exc}", file=sys.stderr)
        return 1

    configure_logging(level=config.log_level)
    log = structlog.get_logger()
    log.info(
        "apiarist starting",
        version=__version__,
        socket_path=str(config.socket_path),
        backend_url=config.backend_url,
        log_level=config.log_level,
    )

    # Scaffold mode: subsystems still being added phase by phase. Phase D
    # adds the asyncio UDS server; until then `apiarist` exits cleanly
    # after logging its config so packaging + config + logging can be
    # exercised end to end.
    log.info(
        "apiarist scaffold; subsystems not yet wired (see DESIGN.md)",
        next_phase="D (UDS server)",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
