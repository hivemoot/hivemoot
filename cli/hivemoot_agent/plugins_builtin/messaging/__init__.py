"""Messaging plugin — chat messaging with platform adapters."""

from __future__ import annotations

import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.messaging.system_prompt import SYSTEM_PROMPT


class MessagingPlugin:
    name = "messaging"
    version = "0.2.0"
    description = "Chat messaging with typing indicators and response delivery"

    def __init__(self) -> None:
        self._platform_adapter: Any = None
        self._typing_stop: threading.Event = threading.Event()
        self._typing_thread: threading.Thread | None = None

    def setup(self, config: PluginConfig) -> None:
        pass

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        platform = config.get("MESSAGING_PLATFORM", "telegram")

        adapter = self._load_platform(platform)
        if adapter is None:
            errors.append(f"Unknown platform: {platform}")
            return errors

        errors.extend(adapter.validate_config(config))

        if not config.get("MESSAGING_AGENT_ID"):
            errors.append("MESSAGING_AGENT_ID is required")

        seen: set[str] = set()
        return [e for e in errors if not (e in seen or seen.add(e))]  # type: ignore[func-returns-value]

    def triggers(self) -> list[Trigger]:
        from hivemoot_agent.plugins_builtin.messaging.trigger import (
            MessagingTrigger,
        )

        return [MessagingTrigger(self)]

    def system_prompt(self, config: PluginConfig) -> str:
        return SYSTEM_PROMPT

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        """Start typing indicator (skip for non-chat sessions)."""
        chat_id = self._extract_chat_id(job.session_key)
        if not chat_id:
            return
        adapter = self.get_adapter()
        if adapter is None:
            return

        self._typing_stop.clear()
        self._typing_thread = threading.Thread(
            target=self._typing_loop,
            args=(adapter, config, chat_id),
            daemon=True,
        )
        self._typing_thread.start()

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        """Stop typing.  For Claude, response was sent via MCP during
        execution.  For other providers, send the extracted response."""
        self._typing_stop.set()
        if self._typing_thread:
            self._typing_thread.join(timeout=5)
            self._typing_thread = None

        chat_id = self._extract_chat_id(job.session_key)
        adapter = self.get_adapter()
        if not chat_id or not adapter:
            return

        if result.response:
            # Non-MCP provider — send the extracted response.
            adapter.send(config, chat_id, result.response)
        elif result.exit_code != 0:
            adapter.send(config, chat_id, "Something went wrong.")

    # ── Internal ───────────────────────────────────────────────────

    def _load_platform(self, name: str = "telegram") -> Any:
        if self._platform_adapter is not None:
            return self._platform_adapter

        if name == "telegram":
            from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import (
                TelegramAdapter,
            )

            self._platform_adapter = TelegramAdapter()
            return self._platform_adapter

        return None

    def get_adapter(self) -> Any:
        return self._platform_adapter or self._load_platform()

    def _extract_chat_id(self, session_key: str) -> str:
        """Extract chat_id from session key (e.g., 'tg:12345' → '12345').

        Returns empty string for non-chat sessions so lifecycle
        callbacks skip gracefully (e.g., oneshot mode).
        """
        if ":" in session_key:
            return session_key.split(":", 1)[1]
        return ""

    def _typing_loop(
        self, adapter: Any, config: PluginConfig, chat_id: str
    ) -> None:
        adapter.typing(config, chat_id)
        while not self._typing_stop.wait(4):
            adapter.typing(config, chat_id)


def create_plugin() -> Plugin:
    return MessagingPlugin()  # type: ignore[return-value]
