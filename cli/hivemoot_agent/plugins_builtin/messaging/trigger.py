"""Messaging trigger — polls a platform for inbound messages."""

from __future__ import annotations

import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig


class MessagingTrigger:
    """Polls a messaging platform and dispatches jobs."""

    name = "messaging"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        if not config.get("MESSAGING_AGENT_ID"):
            errors.append("MESSAGING_AGENT_ID is required")
        return errors

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        adapter = self._plugin.get_adapter()
        if adapter is None:
            print("[trigger] no adapter loaded", file=sys.stderr, flush=True)
            return

        allowed = set()
        allowed_raw = config.get("MESSAGING_ALLOWED_CHAT_IDS", "")
        if allowed_raw:
            allowed = {c.strip() for c in allowed_raw.split(",") if c.strip()}

        timeout = int(config.get("TELEGRAM_POLL_TIMEOUT_SECS", "30"))
        offset = 0
        self._stop_event.clear()

        print(
            f"[trigger] polling (offset={offset}, timeout={timeout}, "
            f"allowed={allowed})",
            file=sys.stderr, flush=True,
        )

        while not self._stop_event.is_set():
            messages = adapter.poll(config, offset, timeout)
            if messages:
                print(
                    f"[trigger] got {len(messages)} update(s)",
                    file=sys.stderr, flush=True,
                )

            for msg in messages:
                update_id = msg.get("update_id", 0)
                chat_id = msg.get("chat_id", "")
                text = msg.get("text", "")

                print(
                    f"[trigger] id={update_id} chat={chat_id} "
                    f"text={text[:40]!r}",
                    file=sys.stderr, flush=True,
                )

                if not text or not chat_id:
                    print("[trigger] skip: no text/chat", file=sys.stderr, flush=True)
                    offset = max(offset, update_id + 1)
                    continue

                if not allowed or chat_id not in allowed:
                    print(f"[trigger] deny: chat={chat_id}", file=sys.stderr, flush=True)
                    offset = max(offset, update_id + 1)
                    continue

                print(f"[trigger] dispatching for chat={chat_id}", file=sys.stderr, flush=True)
                job = Job(session_key=f"tg:{chat_id}", prompt=text)

                # Always advance the offset — a failed run must never
                # cause the same user message to be re-processed, or
                # a persistent error creates an infinite spam loop.
                ok = dispatcher.dispatch(job)
                offset = max(offset, update_id + 1)
                if ok:
                    print(f"[trigger] ok, offset→{offset}", file=sys.stderr, flush=True)
                else:
                    print(f"[trigger] dispatch failed, offset→{offset}", file=sys.stderr, flush=True)

    def stop(self) -> None:
        self._stop_event.set()
