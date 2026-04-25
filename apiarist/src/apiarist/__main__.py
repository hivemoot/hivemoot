"""apiarist CLI entry point.

Phase A scaffold: parses --version / --help and exits. Phases B onward
add config loading, the asyncio UDS server, the backend client, and the
feature plugins. The full design lives in DESIGN.md.
"""

from __future__ import annotations

import argparse
import sys

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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    parser.parse_args(argv)
    # Phase A is a scaffold. The daemon loop lands in Phase D
    # (server.py + core/ipc.py). For now `apiarist` with no args is
    # a no-op that exits cleanly so packaging and entry-point wiring
    # can be verified end to end.
    print(
        "apiarist scaffold (Phase A) — daemon loop arrives in Phase D. "
        "See DESIGN.md.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
