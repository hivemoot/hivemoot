"""Platform adapters for messaging.

Each adapter implements:
    validate_token(token: str) -> bool
    poll(token: str, offset: int, timeout: int) -> list[dict]
    send(token: str, chat_id: str, text: str) -> bool
    typing(token: str, chat_id: str) -> bool
"""

from __future__ import annotations

from typing import Protocol


class PlatformAdapter(Protocol):
    """Contract that every platform module must satisfy."""

    def validate_token(self, token: str) -> bool: ...
    def poll(self, token: str, offset: int, timeout: int) -> list[dict]: ...
    def send(self, token: str, chat_id: str, text: str) -> bool: ...
    def typing(self, token: str, chat_id: str) -> bool: ...


def load_adapter(platform: str) -> PlatformAdapter:
    """Import and return the adapter module for the given platform name."""
    if platform == "telegram":
        from hivemoot_agent.messaging.platforms import telegram

        return telegram  # type: ignore[return-value]

    raise ValueError(f"Unknown messaging platform: {platform}")
