"""CLI commands for extract: response extraction from provider logs."""

from __future__ import annotations

import argparse
import sys

from hivemoot_agent.extract.providers import extract_response


def register_extract_commands(subparsers: argparse._SubParsersAction) -> None:
    """Register the 'extract' command group."""
    ext = subparsers.add_parser("extract", help="Extract data from agent logs")
    ext_sub = ext.add_subparsers(dest="extract_command")

    resp = ext_sub.add_parser(
        "response",
        help="Extract the agent's final response from a run log",
    )
    resp.add_argument(
        "--provider",
        required=True,
        choices=["claude", "codex", "gemini", "kilo", "opencode"],
        help="AI provider that produced the log",
    )
    resp.add_argument(
        "--log-file",
        required=True,
        help="Path to the provider's run log",
    )
    resp.add_argument(
        "--sidecar-file",
        default="",
        help="Codex sidecar answer file (--output-last-message)",
    )
    resp.set_defaults(func=cmd_response)

    ext.set_defaults(func=lambda args: ext.print_help() or 0)


def cmd_response(args: argparse.Namespace) -> int:
    """Extract and print the agent's final response."""
    text = extract_response(
        provider=args.provider,
        log_file=args.log_file,
        sidecar_file=args.sidecar_file or None,
    )
    if text:
        print(text, end="")
        return 0

    print("No response extracted from log", file=sys.stderr)
    return 1
