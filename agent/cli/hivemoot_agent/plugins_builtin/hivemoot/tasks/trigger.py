"""Hivemoot delegated-task trigger — polls the backend for new tasks."""

from __future__ import annotations

import os
import string
import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot.tasks import api


_TASK_TEMPLATE_PATH = os.path.join(
    os.path.dirname(__file__), "prompts", "messages", "task.md",
)



def _render_messages_block(messages: list[dict]) -> str:
    """Render the conversation history into the prompt body.

    Mirrors the deleted shell ``render_task_messages_block`` so a
    re-opened task carries forward the prior turns instead of being
    handed an empty context.  Empty input returns "".
    """
    if not messages:
        return ""
    lines: list[str] = [
        "## Conversation Context",
        "Use this complete timeline as additional context for "
        "follow-up/reopened work.",
        "",
    ]
    for idx, msg in enumerate(messages, start=1):
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "unknown")
        created_at = str(msg.get("created_at") or "unknown")
        content = str(msg.get("content") or "")
        lines.append(f"### Message {idx} ({role} @ {created_at})")
        lines.append(content)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _render_task_prompt(task_id: str, task_prompt: str, messages: list[dict]) -> str:
    """Compose the per-task prompt: template + messages history.

    Uses ``string.Template``-style ``${task_id}`` / ``${task_prompt}``
    substitution so the same ``prompts/messages/task.md`` the shell
    used continues to source the prompt body.  Falls back to a minimal
    composition if the template is missing.
    """
    try:
        with open(_TASK_TEMPLATE_PATH) as f:
            tmpl = string.Template(f.read())
        body = tmpl.safe_substitute(task_id=task_id, task_prompt=task_prompt)
    except OSError:
        body = f"# Task\n\nID: {task_id}\n\n{task_prompt}\n"

    messages_block = _render_messages_block(messages)
    if messages_block:
        return f"{body.rstrip()}\n\n{messages_block}"
    return body


class HivemootTaskTrigger:
    """Poll the hivemoot.dev claim endpoint and dispatch a Job per claim.

    Same shape as MessagingTrigger — single ``start()`` loop, blocks
    until ``stop()`` flips the event.  Each dispatch carries the
    claimed task's identity in ``Job.metadata`` so the plugin's
    lifecycle hooks can drive the heartbeat / result-reporting flow
    without re-querying the backend.
    """

    name = "hivemoot-tasks"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        # Parent plugin does the combined validation so operators get
        # one consolidated error bundle rather than scattered per-trigger
        # messages.
        return []

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        cfg = config.typed
        tasks = cfg.tasks if cfg is not None else None
        if tasks is None or not tasks.enabled or not tasks.claim_url:
            print(
                "[hivemoot-tasks] tasks disabled or claim_url empty; "
                "trigger idle",
                file=sys.stderr, flush=True,
            )
            return

        claim_url = tasks.claim_url
        poll_interval = max(1, tasks.poll_interval_secs)
        token_file = str(cfg.token_file) if cfg.token_file else ""

        self._stop_event.clear()
        print(
            f"[hivemoot-tasks] polling {claim_url} every {poll_interval}s",
            file=sys.stderr, flush=True,
        )

        while not self._stop_event.is_set():
            # In-flight gate.  Engine's dispatcher is async (enqueues
            # onto the keyed workqueue, returns before on_job_started
            # fires); without this block the claim loop would
            # pre-claim backend tasks faster than the single-worker
            # queue drains them.  Pre-claimed tasks sit silent in the
            # queue with no progress posts, and a worker crash or
            # restart strands them with no terminal state reported
            # to the backend.  Gate via a plugin-exposed Event:
            # on_job_finished sets it; we clear it just before
            # dispatching the next claim.
            if not self._plugin.wait_task_slot(self._stop_event, timeout=1.0):
                # Still draining the previous task — loop back to
                # check the stop event, then wait again.  1s slice
                # is tight enough for prompt shutdown without burning
                # CPU.
                continue

            # Re-resolve the bearer per claim attempt so an operator
            # rotating HIVEMOOT_AGENT_TOKEN{,_FILE} takes effect
            # within the next poll_interval_secs rather than waiting
            # for a process restart.  One tiny file read per poll.
            bearer = api.resolve_executor_token(token_file)

            try:
                claimed = api.claim_next_task(claim_url, bearer)
            except Exception as exc:
                print(
                    f"[hivemoot-tasks] claim failed: {type(exc).__name__}: {exc}",
                    file=sys.stderr, flush=True,
                )
                # Wait the full poll interval before retrying so a
                # persistently-broken backend doesn't get hammered.
                self._stop_event.wait(poll_interval)
                continue

            if claimed is None:
                # No task available — sleep and poll again.
                self._stop_event.wait(poll_interval)
                continue

            print(
                f"[hivemoot-tasks] claimed task {claimed.task_id}",
                file=sys.stderr, flush=True,
            )

            # Render the per-task prompt (template + conversation history)
            # at dispatch time so the engine sees the full body without
            # the plugin needing to mutate Job.prompt later.
            prompt_body = _render_task_prompt(
                claimed.task_id, claimed.prompt, claimed.messages,
            )

            job = Job(
                session_key=f"task:{claimed.task_id}",
                prompt=prompt_body,
                metadata={
                    "task_id": claimed.task_id,
                    "claim_token": claimed.claim_token,
                    "messages": claimed.messages,
                },
            )

            # Reserve the slot *before* dispatch.  on_job_finished is
            # the ONLY path that reopens it (including the failure
            # path — see HivemootPlugin.on_job_finished's finally
            # block).  Dispatch-failed is the one case we must
            # reopen manually since the engine never calls the hook.
            self._plugin.reserve_task_slot()
            ok = dispatcher.dispatch(job)
            if not ok:
                print(
                    f"[hivemoot-tasks] dispatch failed for {claimed.task_id}",
                    file=sys.stderr, flush=True,
                )
                self._plugin.release_task_slot()

    def stop(self) -> None:
        self._stop_event.set()
