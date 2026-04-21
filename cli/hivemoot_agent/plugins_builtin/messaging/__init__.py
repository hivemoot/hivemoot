"""Messaging plugin — chat messaging with platform adapters."""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentEvent,
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.messaging.config import MessagingConfig
from hivemoot_agent.plugins_builtin.messaging.system_prompt import SYSTEM_PROMPT


# Per-job context file the cli.py send-file subcommand reads to find
# the active chat_id + platform.  Lives in tmpfs so it's per-container
# and disappears on restart.  Written in on_job_started, removed in
# on_job_finished so a stale context can't leak across jobs.
_JOB_CONTEXT_PATH = Path("/tmp/.messaging-job-context.json")


def _format_status(text: str) -> str:
    """Extract a short status line from agent text.

    Takes the first line, strips leading markdown artifacts
    (# headers, * bullets, - dashes), and caps at 200 chars.
    """
    line = text.split("\n", 1)[0].strip()
    # Strip leading header markers (e.g., "## Heading" -> "Heading").
    line = line.lstrip("#").strip()
    # Strip leading list marker (e.g., "* item" or "- item" -> "item").
    if line.startswith(("* ", "- ")):
        line = line[2:].strip()
    if len(line) > 200:
        line = line[:197] + "..."
    return line


class MessagingPlugin:
    name = "messaging"
    version = "0.4.0"
    description = (
        "Chat messaging with typing indicators, streaming progress, response "
        "delivery, and bidirectional media (download + send-file)."
    )

    def __init__(self) -> None:
        self._platform_adapter: Any = None
        self._typing_stop: threading.Event = threading.Event()
        self._typing_thread: threading.Thread | None = None
        # Streaming progress state.
        self._status_msg_id: str = ""
        self._status_chat_id: str = ""
        self._last_status_time: float = 0.0
        self._status_closed = True
        self._status_epoch = 0
        self._status_lock: threading.Lock = threading.Lock()
        self._status_queue: queue.Queue[tuple[Any, ...]] = queue.Queue()
        self._status_thread = threading.Thread(
            target=self._status_loop,
            daemon=True,
        )
        self._status_thread.start()

    def setup(self, config: PluginConfig) -> None:
        pass

    def validate(self, config: PluginConfig) -> list[str]:
        """Config-level validation beyond what Pydantic covers.

        The Pydantic schema (MessagingConfig) already enforces types,
        required fields, and ranges — anything that fails there raises
        before this method runs.  This method handles the two
        cross-cutting checks that don't fit a single field's schema:
        platform-specific adapter validation, and runtime token
        availability.
        """
        errors: list[str] = []
        cfg: MessagingConfig = config.typed
        adapter = self._load_platform(cfg.platform)
        if adapter is None:
            errors.append(f"Unknown platform: {cfg.platform}")
            return errors
        errors.extend(adapter.validate_config(config))
        # Order-preserving dedup — dict.fromkeys keeps the first
        # occurrence of each error string, which matters when the
        # same validation error bubbles up from multiple layers
        # (e.g. both the plugin's own check and the adapter's).
        return list(dict.fromkeys(errors))

    def triggers(self) -> list[Trigger]:
        from hivemoot_agent.plugins_builtin.messaging.trigger import (
            MessagingTrigger,
        )

        return [MessagingTrigger(self)]

    def system_prompt(self, config: PluginConfig) -> str:
        return SYSTEM_PROMPT

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        """Start typing indicator and reset progress state."""
        with self._status_lock:
            self._status_epoch += 1
            self._status_msg_id = ""
            self._status_chat_id = ""
            self._last_status_time = 0.0
            self._status_closed = False

        chat_id = self._extract_chat_id(job.session_key)
        if not chat_id:
            return
        adapter = self.get_adapter()
        if adapter is None:
            return

        # Write the active job's chat context so the cli.py send-file
        # subcommand the agent invokes can resolve the destination
        # without the agent having to know the chat_id.  Best-effort:
        # if /tmp isn't writable for some reason, the file ops degrade
        # gracefully (CLI returns a clear error pointing at the
        # missing context file).  Skipped when typed config isn't
        # populated (tests that instantiate the plugin directly
        # without going through the engine) — the context file only
        # exists to help the send-file CLI and that CLI requires a
        # full hivemoot.yaml anyway.
        cfg: MessagingConfig | None = config.typed
        if cfg is not None:
            try:
                _JOB_CONTEXT_PATH.write_text(json.dumps({
                    "chat_id": chat_id,
                    "platform": cfg.platform,
                    "session_key": job.session_key,
                }))
            except OSError as exc:
                print(
                    f"[messaging] warn: could not write job context: {exc}",
                    file=sys.stderr, flush=True,
                )

        self._typing_stop.clear()
        self._typing_thread = threading.Thread(
            target=self._typing_loop,
            args=(adapter, config, chat_id),
            daemon=True,
        )
        self._typing_thread.start()

    def on_agent_output(
        self, job: Job, event: AgentEvent, config: PluginConfig,
    ) -> None:
        """React to a streaming event from the agent subprocess.

        Queue status updates for background delivery so Telegram I/O
        never blocks stdout parsing or the final reply path.
        """
        if event.kind != "assistant_message":
            return

        status = _format_status(event.text)
        if len(status) < 10:
            return

        with self._status_lock:
            if self._status_closed:
                return

            chat_id = self._status_chat_id
            if not chat_id:
                chat_id = self._extract_chat_id(job.session_key)
                if not chat_id:
                    return
                self._status_chat_id = chat_id

            epoch = self._status_epoch

        self._status_queue.put(("status", epoch, config, chat_id, status))

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        """Stop typing, delete status message, send final response."""
        self._typing_stop.set()
        if self._typing_thread:
            self._typing_thread.join(timeout=5)
            self._typing_thread = None

        # Clear the per-job context file so a stale chat_id can't leak
        # to a future job invoked in the same container.  unlink is
        # missing_ok=True so a missing-file race is silent.
        try:
            _JOB_CONTEXT_PATH.unlink(missing_ok=True)
        except OSError:
            pass

        chat_id = self._extract_chat_id(job.session_key)
        adapter = self.get_adapter()
        if not chat_id or not adapter:
            return

        with self._status_lock:
            self._status_closed = True
            status_msg_id = self._status_msg_id
            status_chat_id = self._status_chat_id or chat_id
            self._status_msg_id = ""
            self._status_chat_id = ""
            self._last_status_time = 0.0

        # Best-effort cleanup should not delay the user-visible reply.
        if status_msg_id and status_chat_id:
            self._status_queue.put(
                ("delete", config, status_chat_id, status_msg_id),
            )

        if result.response:
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
        """Extract chat_id from session key (e.g., 'tg:12345' -> '12345').

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

    def _status_loop(self) -> None:
        """Deliver status updates in the background."""
        while True:
            item = self._status_queue.get()
            try:
                action = item[0]
                if action == "status":
                    _, epoch, config, chat_id, status = item
                    self._deliver_status(epoch, config, chat_id, status)
                elif action == "delete":
                    _, config, chat_id, message_id = item
                    self._delete_status_message(config, chat_id, message_id)
            except Exception as exc:
                print(
                    f"[messaging] status worker error: {exc}",
                    file=sys.stderr, flush=True,
                )
            finally:
                self._status_queue.task_done()

    def _deliver_status(
        self,
        epoch: int,
        config: PluginConfig,
        chat_id: str,
        status: str,
    ) -> None:
        """Send or edit a status message for the active job."""
        adapter = self.get_adapter()
        if adapter is None:
            return

        with self._status_lock:
            if self._status_closed or epoch != self._status_epoch:
                return
            message_id = self._status_msg_id
            last_status_time = self._last_status_time

        now = time.monotonic()

        if message_id:
            if now - last_status_time < 1.5:
                return
            adapter.edit_message(config, chat_id, message_id, status)
            with self._status_lock:
                if not self._status_closed and epoch == self._status_epoch:
                    self._last_status_time = now
            return

        message_id = adapter.send_and_get_id(config, chat_id, status)
        if not message_id:
            return

        with self._status_lock:
            closed_or_stale = self._status_closed or epoch != self._status_epoch
            if not closed_or_stale:
                self._status_msg_id = message_id
                self._status_chat_id = chat_id
                self._last_status_time = now

        if closed_or_stale:
            self._delete_status_message(config, chat_id, message_id)

    def _delete_status_message(
        self, config: PluginConfig, chat_id: str, message_id: str,
    ) -> None:
        """Delete a status message without affecting the final reply path."""
        adapter = self.get_adapter()
        if adapter is None:
            return
        adapter.delete_message(config, chat_id, message_id)


def create_plugin() -> Plugin:
    return MessagingPlugin()  # type: ignore[return-value]
