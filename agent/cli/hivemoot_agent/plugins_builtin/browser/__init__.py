"""Browser plugin — CDP attach to a deployer-run browser sidecar.

Promoted from apiary's external ``apiary-browser`` plugin to a
built-in under the runtime tree.  The plugin's job is small:

  * validate() probes the configured CDP endpoint so a missing /
    misconfigured sidecar fails the agent at startup, not on the
    first browser call.
  * setup() exports ``BROWSER_CDP_URL`` into the process environment
    so the cli.py wrapper (invoked by the agent as a subprocess) can
    read it without re-loading the YAML config.
  * system_prompt() ships the operator-facing brief on when (and
    when not) to reach for the browser tool.

No event source — the browser is called on demand by the agent via
``python3 -m hivemoot_agent.plugins_builtin.browser.cli <subcommand>``.

Architecture: one shared sidecar container exposes CDP on the
deployer's network; every opted-in agent attaches to it via
``connect_over_cdp`` from its own process.  Per-agent isolation is
the cli.py's job (``--session-name`` keyed by ``AGENT_ID``, plus
``--state`` for cross-restart persistence on the /state mount).
No browser binary in the agent image — keeps the runtime lean.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.browser.config import BrowserConfig


_PLUGIN_DIR = Path(__file__).resolve().parent
_SYSTEM_PROMPT_PATH = _PLUGIN_DIR / "system_prompt.md"

# Connectivity probe timeout — short enough that a missing sidecar
# fails the agent fast, long enough that a momentarily slow Chrome
# boot doesn't false-positive.
_PROBE_TIMEOUT_SECS = 5


class BrowserPlugin:
    name = "browser"
    version = "0.2.0"
    description = (
        "Browser automation via CDP attach to a deployer-run sidecar"
    )

    def validate(self, config: PluginConfig) -> list[str]:
        """Fail-fast on missing or unreachable browser sidecar.

        Any agent that activates this plugin needs the browser to be
        reachable.  Surface "sidecar not running" at startup instead
        of at the first browser call hours later.
        """
        from hivemoot_agent.plugins_builtin.browser.config import BrowserConfig

        cfg: BrowserConfig | None = config.typed
        if cfg is None:
            return [
                "browser plugin requires typed config (plugins.browser in "
                "hivemoot.yaml).  Env-var configuration was removed when "
                "the plugin was promoted to built-in (0.2.0)."
            ]

        errors: list[str] = []
        cdp_url = cfg.cdp_url.strip()
        if not cdp_url:
            errors.append(
                "plugins.browser.cdp_url is required and must point at a "
                "reachable CDP endpoint (e.g. http://hivemoot-browser:3000)."
            )
            return errors

        # Probe /json/version — Chrome DevTools' standard liveness
        # endpoint.  Returns {"Browser": "...", "Protocol-Version": ...}
        # when Chrome is up.  Any non-2xx or socket error means the
        # sidecar is missing or wrong port.
        probe_url = cdp_url.rstrip("/") + "/json/version"
        try:
            with urllib.request.urlopen(probe_url, timeout=_PROBE_TIMEOUT_SECS) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                payload = json.loads(body)
                if "Browser" not in payload:
                    errors.append(
                        f"browser: cdp_url probe returned unexpected "
                        f"payload (no 'Browser' key) from {probe_url}"
                    )
        except urllib.error.URLError as exc:
            errors.append(
                f"browser: cannot reach cdp_url ({probe_url}): "
                f"{exc.reason if hasattr(exc, 'reason') else exc}.  "
                "Verify the browser sidecar is running and the URL is "
                "reachable from this container's network."
            )
        except (json.JSONDecodeError, ValueError) as exc:
            errors.append(
                f"browser: cdp_url probe at {probe_url} did not return "
                f"valid JSON: {exc}"
            )
        return errors

    def setup(self, config: PluginConfig) -> None:
        """Export cdp_url to the process env for the cli.py subprocess.

        The cli.py wrapper is invoked by the agent as a subprocess and
        reads BROWSER_CDP_URL from its environment.  We populate it
        once at startup from the typed config so cli.py doesn't have
        to re-load the YAML on every invocation.
        """
        from hivemoot_agent.plugins_builtin.browser.config import BrowserConfig

        cfg: BrowserConfig | None = config.typed
        if cfg is None:
            raise RuntimeError("browser plugin setup called without typed config")

        os.environ["BROWSER_CDP_URL"] = cfg.cdp_url.strip()
        os.environ["BROWSER_STATE_DIR"] = cfg.state_dir.strip()

        agent_id = (config.get("AGENT_ID", "") or "anonymous").strip()
        tool_status = "ok" if shutil.which("agent-browser") else (
            "MISSING — agent-browser CLI not found on PATH; rebuild the "
            "runtime image (hivemoot-agent#593 added it to the base stage)."
        )
        print(
            f"[browser] ready: cdp={cfg.cdp_url} agent_id={agent_id} "
            f"state_dir={cfg.state_dir} agent-browser={tool_status}",
            file=sys.stderr,
            flush=True,
        )

    def triggers(self) -> list[Trigger]:
        # No event source — the browser is called on demand by the agent.
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        try:
            return _SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
        except OSError:
            # Plugin can still load if the prompt file is missing
            # (e.g. mid-edit on a dev box) — just skip the contribution.
            return ""

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return BrowserPlugin()  # type: ignore[return-value]
