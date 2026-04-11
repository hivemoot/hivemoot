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

SYSTEM_PROMPT = """\
# Messaging Mode

You are responding to a direct message from a user on a messaging \
platform. This is a conversation, not an autonomous work session.

## How to respond

Use the `send_message` tool to send your response to the user. \
Do NOT just print text to the console — the user will only see \
messages sent through the tool.

To share files (images, documents, audio), use the `send_file` tool.

## Rules

- Respond directly to what the user asked.
- Be concise. Messaging platforms have limited screen space.
- Multi-turn aware. Reference session history naturally.
- If blocked, say what you need. Don't speculate.
- No artifacts unless explicitly asked.
- Markdown is supported in send_message (bold, italic, code, links).
"""


class MessagingPlugin:
    name = "messaging"
    version = "0.2.0"
    description = "Chat messaging with typing indicators and response delivery"

    def __init__(self) -> None:
        self._platform_adapter: Any = None
        self._typing_stop: threading.Event = threading.Event()
        self._typing_thread: threading.Thread | None = None

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
        """Start typing indicator."""
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
        if ":" in session_key:
            return session_key.split(":", 1)[1]
        return session_key

    def _typing_loop(
        self, adapter: Any, config: PluginConfig, chat_id: str
    ) -> None:
        adapter.typing(config, chat_id)
        while not self._typing_stop.wait(4):
            adapter.typing(config, chat_id)


def create_plugin() -> Plugin:
    return MessagingPlugin()  # type: ignore[return-value]
