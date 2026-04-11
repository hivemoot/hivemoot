"""CLI commands for plugin management."""

from __future__ import annotations

import argparse
import os
import sys

from hivemoot_agent.plugins import registry
from hivemoot_agent.plugins.interfaces import PluginConfig


def register_plugin_commands(subparsers: argparse._SubParsersAction) -> None:
    """Register the 'plugin' command group."""
    plug = subparsers.add_parser("plugin", help="Manage plugins")
    plug_sub = plug.add_subparsers(dest="plugin_command")

    ls = plug_sub.add_parser("list", help="List all discovered plugins")
    ls.set_defaults(func=cmd_list)

    doc = plug_sub.add_parser("doctor", help="Validate a plugin's config")
    doc.add_argument("name", help="Plugin name")
    doc.set_defaults(func=cmd_doctor)

    plug.set_defaults(func=lambda args: plug.print_help() or 0)


def cmd_list(args: argparse.Namespace) -> int:
    registry.discover()
    plugins = registry.all()

    if not plugins:
        print("No plugins found.")
        return 0

    print(f"{'PLUGIN':<20} {'VERSION':<10} {'DESCRIPTION'}")
    print("-" * 60)
    for name, plugin in sorted(plugins.items()):
        print(f"{plugin.name:<20} {plugin.version:<10} {plugin.description}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    registry.discover()
    plugin = registry.get(args.name)

    if plugin is None:
        print(f"Plugin '{args.name}' not found", file=sys.stderr)
        available = ", ".join(registry.all().keys())
        if available:
            print(f"Available: {available}", file=sys.stderr)
        return 1

    config = registry.config_for(args.name)
    errors = plugin.validate(config)

    if not errors:
        print(f"  \u2713 Plugin '{args.name}' v{plugin.version}: all checks passed")
        return 0

    print(f"  \u2717 Plugin '{args.name}' v{plugin.version}: {len(errors)} issue(s)")
    for err in errors:
        print(f"    - {err}")
    return 1
