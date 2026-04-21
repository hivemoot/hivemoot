"""Pydantic config schema for the messaging plugin.

Referenced from ``plugin.yaml``; every field flows in from
``plugins.messaging`` in ``hivemoot.yaml``.

Secret handling: ``bot_token_file`` points at a file containing the
Telegram bot API token (plain text).  The deployer names the file
via ``!secret telegram_bot_token`` in hivemoot.yaml, which resolves
through hivemoot.secrets.yaml to the actual mount path
(``/run/secrets/telegram-bot-token`` by convention).  The token
itself is never serialized into config values — keeps it off the
process argv and out of ``env``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class MessagingConfig(StrictPluginConfig):
    """Config schema for the messaging plugin.

    Today only ``telegram`` is supported as ``platform``; the type
    stays a ``Literal`` so adding Slack / Discord in the future is a
    widening change on this one field rather than a free-form string.
    """

    platform: Literal["telegram"] = Field(
        default="telegram",
        description="Messaging platform to poll.",
    )
    agent_id: str = Field(
        description=(
            "Identity shown in messages.  Matches the agent's role "
            "name (e.g. 'queen').  Used as the key for per-agent "
            "storage state in sibling plugins like apiary-browser."
        ),
    )
    allowed_chat_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Chat IDs permitted to send messages.  Empty list = deny "
            "all (safer default than allow-all).  Telegram chat IDs "
            "are numeric strings."
        ),
    )
    poll_timeout_secs: int = Field(
        default=30,
        ge=5,
        le=300,
        description=(
            "Long-poll timeout passed to getUpdates.  Higher = fewer "
            "wasted round-trips; lower = faster shutdown response."
        ),
    )
    bot_token_file: Path | None = Field(
        default=None,
        description=(
            "Path to the file containing the Telegram bot API token. "
            "Typically written by the deployer as "
            "``!secret telegram_bot_token`` in hivemoot.yaml."
        ),
    )

