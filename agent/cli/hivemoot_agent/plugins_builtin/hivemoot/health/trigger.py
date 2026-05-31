"""Agent-health heartbeat trigger.

Runs in its own thread inside ``hivemoot-agent run`` and posts a
liveness heartbeat to ``/api/agent-health`` every
``health.heartbeat_interval_secs``.  An immediate heartbeat fires at
``start()`` so the dashboard shows the agent the moment its container
boots rather than waiting a full interval.

The trigger does not dispatch Jobs — it never calls
``dispatcher.dispatch``.  Health reporting is a side channel, not a
work source.
"""

from __future__ import annotations

import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot import auth
from hivemoot_agent.plugins_builtin.hivemoot.health import api


class HealthHeartbeatTrigger:
    """Periodic heartbeat poster; stops on ``stop()``."""

    name = "hivemoot-health-heartbeat"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        # Parent plugin does the combined validation so operators get
        # one consolidated error bundle rather than scattered per-trigger
        # messages.
        return []

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        del dispatcher  # heartbeats are a side channel, not a work source
        cfg = config.typed
        if cfg is None or not cfg.health.enabled:
            return

        token_file = str(cfg.token_file) if cfg.token_file else ""
        agent_id = self._plugin.resolved_agent_id()
        base_url = cfg.health.base_url
        interval = cfg.health.heartbeat_interval_secs

        if not agent_id or not base_url:
            print(
                "[hivemoot-health] missing agent_id/base_url; "
                "heartbeat trigger idle",
                file=sys.stderr, flush=True,
            )
            return

        self._stop_event.clear()
        print(
            f"[hivemoot-health] heartbeating {base_url} every {interval}s "
            f"(agent={agent_id})",
            file=sys.stderr, flush=True,
        )

        # Initial heartbeat so the dashboard shows the agent immediately.
        # Short-circuit on stop so a shutdown wedged between start()
        # returning and the first tick doesn't pointlessly fire one more
        # POST.
        if self._stop_event.is_set():
            return
        self._tick(base_url, token_file, agent_id)

        while not self._stop_event.wait(interval):
            self._tick(base_url, token_file, agent_id)

    def stop(self) -> None:
        self._stop_event.set()

    @staticmethod
    def _tick(
        base_url: str, token_file: str, agent_id: str,
    ) -> None:
        # Re-resolve the bearer per tick so token rotation takes
        # effect within one interval rather than waiting for a
        # process restart.  One small file read per heartbeat —
        # negligible vs. the outbound POST.
        bearer = auth.resolve_agent_token(token_file)
        try:
            ok = api.post_heartbeat(
                base_url, bearer, agent_id=agent_id,
            )
            if not ok:
                print(
                    f"[hivemoot-health] heartbeat returned non-200 "
                    f"(agent={agent_id})",
                    file=sys.stderr, flush=True,
                )
        except Exception as exc:
            print(
                f"[hivemoot-health] heartbeat error "
                f"(agent={agent_id}): "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr, flush=True,
            )
