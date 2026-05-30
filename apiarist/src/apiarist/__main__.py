"""apiarist CLI entry point.

Phases A+B set up packaging, config loading, structured logging.
Phase C added the backend client (apiarist/core/backend.py).
Phases D+E+F (this file's significant work) wire the asyncio UDS server,
the mint_token feature, and the health op into a complete daemon loop.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import signal
import sys
from pathlib import Path

import structlog

from apiarist.config import Config, ConfigError, load_config
from apiarist.core.backend import BackendClient
from apiarist.core.registry import Registry
from apiarist.features import health as health_feature
from apiarist.features.reconcile.client import FleetClient
from apiarist.features.reconcile.docker import HttpxDockerClient
from apiarist.features.reconcile.loop import ReconcileLoop
from apiarist.features.reconcile.loop import register as reconcile_register
from apiarist.features.reconcile.reconcile import Reconciler
from apiarist.features.tokens import plugin as tokens_feature
from apiarist.features.tokens.cache import TokenCache
from apiarist.logging import configure_logging
from apiarist.server import Server
from apiarist.version import __version__

_AGENT_TOKEN_ENV = "APIARIST_AGENT_TOKEN"
_FLEET_TOKEN_ENV = "APIARIST_FLEET_TOKEN"


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
        # Pre-logging-configured failure: stderr only.
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

    # Agent token loading — V1 takes it from APIARIST_AGENT_TOKEN env.
    # Future phases will read multi-token mappings from
    # apiary.secrets.yaml per DESIGN.md §9 (multi-installation support).
    agent_token = os.environ.get(_AGENT_TOKEN_ENV, "").strip()
    if not agent_token:
        print(
            f"apiarist: {_AGENT_TOKEN_ENV} env var is required (the bearer "
            "credential for hivemoot.dev — see DESIGN.md §9 multi-token).",
            file=sys.stderr,
        )
        return 1

    # The reconciler (V2) needs its own least-privilege fleet.read bearer,
    # separate from the broker's mint token. Required only when enabled.
    fleet_token = os.environ.get(_FLEET_TOKEN_ENV, "").strip()
    if config.reconcile_enabled and not fleet_token:
        print(
            f"apiarist: reconcile_enabled is set but {_FLEET_TOKEN_ENV} is missing "
            "(the fleet.read bearer for desired-state polling).",
            file=sys.stderr,
        )
        return 1

    try:
        return asyncio.run(_run(config, agent_token, fleet_token))
    except KeyboardInterrupt:
        # asyncio.run raises this on Ctrl-C if no signal handler caught
        # it first. Fall through cleanly; structured shutdown is in _run.
        return 0


async def _run(config: Config, agent_token: str, fleet_token: str) -> int:
    """The actual daemon loop, separated from main() for asyncio.run."""
    log = structlog.get_logger()

    # --- Wire features ------------------------------------------------
    registry = Registry()
    health_state = health_feature.HealthState()
    health_feature.register(registry, state=health_state)

    backend = BackendClient.from_config(config, agent_token=agent_token)
    cache = TokenCache(
        safety_margin_seconds=config.token_cache_safety_margin_seconds,
        max_seconds=config.token_cache_max_seconds,
    )
    tokens_feature.register(
        registry,
        backend=backend,
        cache=cache,
        health_state=health_state,
        agent_token=agent_token,
    )

    # --- Reconcile feature (V2) — wired only when enabled -------------
    reconcile_loop: ReconcileLoop | None = None
    fleet_client: FleetClient | None = None
    docker_client: HttpxDockerClient | None = None
    if config.reconcile_enabled:
        fleet_client = FleetClient(
            backend_url=config.backend_url,
            fleet_token=fleet_token,
            timeout_seconds=config.backend_timeout_seconds,
            retries=config.backend_retries,
        )
        docker_client = HttpxDockerClient(
            socket_path=config.docker_socket_path,
            fleet_data_root=config.fleet_data_root,
            stop_grace_seconds=config.reconcile_stop_grace_seconds,
        )
        reconciler = Reconciler(
            fleet_client=fleet_client,
            docker_client=docker_client,
            backend_url=config.backend_url,
            image=config.reconcile_image,
            image_allowlist=config.reconcile_image_allowlist,
            # Empty allowlist ⇒ manage all (None); a non-empty list scopes the canary.
            managed_filter=set(config.reconcile_managed_agents) or None,
            dry_run=config.reconcile_dry_run,
            max_delete_per_cycle=config.reconcile_max_delete_per_cycle,
            allow_mass_delete=config.reconcile_allow_mass_delete,
        )
        reconcile_loop = ReconcileLoop(
            reconciler=reconciler, interval_seconds=config.reconcile_interval_seconds
        )
        reconcile_register(registry, loop=reconcile_loop)
        log.info(
            "reconcile feature enabled",
            dry_run=config.reconcile_dry_run,
            interval_seconds=config.reconcile_interval_seconds,
            managed_agents=config.reconcile_managed_agents or "all",
        )

    server = Server(
        socket_path=config.socket_path,
        socket_group=config.socket_group,
        registry=registry,
    )

    # --- Bind socket --------------------------------------------------
    try:
        await server.bind()
    except RuntimeError as exc:
        # bind() raises with a self-describing message; surface to stderr
        # so systemd's journal shows it without needing to dig.
        log.error("uds bind failed", error=str(exc))
        print(f"apiarist: bind failed: {exc}", file=sys.stderr)
        await backend.aclose()
        return 1

    # --- Signal handlers for graceful shutdown ------------------------
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _request_stop(signum: int) -> None:
        log.info("shutdown signal received", signal=signum)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_stop, sig)

    log.info("apiarist ready", ops=registry.list_ops())

    # --- Serve until signaled -----------------------------------------
    serve_task = asyncio.create_task(server.serve_forever(), name="serve_forever")
    stop_task = asyncio.create_task(stop_event.wait(), name="stop_event")
    reconcile_task: asyncio.Task[None] | None = (
        asyncio.create_task(reconcile_loop.run(), name="reconcile_loop")
        if reconcile_loop is not None
        else None
    )

    done, pending = await asyncio.wait(
        {serve_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
    )

    # Whichever finished first, tear down the rest cleanly.
    if stop_task in done:
        await server.stop()
    for task in pending:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    if reconcile_loop is not None and reconcile_task is not None:
        reconcile_loop.stop()
        reconcile_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await reconcile_task
    if fleet_client is not None:
        await fleet_client.aclose()
    if docker_client is not None:
        await docker_client.aclose()

    await backend.aclose()
    log.info("apiarist stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
