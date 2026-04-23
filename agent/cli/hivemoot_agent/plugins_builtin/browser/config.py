"""Pydantic config schema for the browser plugin.

Promoted from apiary's external ``apiary-browser`` plugin (apiary#48)
to a built-in under ADR-003.  The typed schema replaces the
``BROWSER_CDP_URL`` env-var contract — operators set ``cdp_url``
directly in ``hivemoot.yaml`` and the plugin reads it from the
validated Pydantic instance.
"""

from __future__ import annotations

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class BrowserConfig(StrictPluginConfig):
    """Browser plugin config — CDP attach to a deployer-run sidecar."""

    cdp_url: str = Field(
        default="http://hivemoot-browser:3000",
        description=(
            "Chrome DevTools Protocol endpoint of the browser sidecar.  "
            "Default matches apiary's hivemoot-browser sidecar service "
            "name; other deployers point this at their own CDP-exposing "
            "container.  The plugin probes this URL at startup and "
            "fails fast if unreachable."
        ),
    )
    state_dir: str = Field(
        default="/state",
        description=(
            "Host-mounted directory for per-agent persistent browser "
            "state files (cookies, localStorage, sessionStorage), one "
            "JSON file per AGENT_ID.  The cli.py wrapper reads/writes "
            "via agent-browser's ``--state`` flag."
        ),
    )
