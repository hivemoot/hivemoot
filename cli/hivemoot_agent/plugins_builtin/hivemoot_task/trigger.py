"""Hivemoot delegated-task trigger — polls the backend for new tasks."""

from __future__ import annotations

import os
import string
import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_task import api


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

    name = "hivemoot-task"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        cfg = config.typed
        if cfg is None:
            return [
                "hivemoot-task trigger requires typed config (plugins."
                "hivemoot-task in hivemoot.yaml)."
            ]
        errors: list[str] = []
        if not cfg.claim_url:
            errors.append(
                "plugins.hivemoot-task.claim_url is required for the "
                "polling trigger"
            )
        if not cfg.execute_base_url:
            errors.append(
                "plugins.hivemoot-task.execute_base_url is required for "
                "the polling trigger"
            )
        if cfg.token_file is None:
            errors.append(
                "plugins.hivemoot-task.token_file is required for backend "
                "auth (typically `!secret hivemoot_agent_token`)"
            )
        return errors

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        cfg = config.typed
        if cfg is None or not cfg.claim_url:
            print(
                "[hivemoot-task] no typed config or empty claim_url; trigger idle",
                file=sys.stderr, flush=True,
            )
            return

        claim_url = cfg.claim_url
        poll_interval = max(1, cfg.poll_interval_secs)
        token_file = str(cfg.token_file) if cfg.token_file else ""
        bearer = api.resolve_executor_token(token_file)

        self._stop_event.clear()
        print(
            f"[hivemoot-task] polling {claim_url} every {poll_interval}s",
            file=sys.stderr, flush=True,
        )

        while not self._stop_event.is_set():
            try:
                claimed = api.claim_next_task(claim_url, bearer)
            except Exception as exc:
                print(
                    f"[hivemoot-task] claim failed: {type(exc).__name__}: {exc}",
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

            # Log shape: "task <id>" always, "(repos=...)" only when
            # the claim carried any — avoids noisy "repo=" for the
            # generic no-repo case.
            repo_tag = (
                f" (repos={','.join(claimed.repos)})"
                if claimed.repos else ""
            )
            print(
                f"[hivemoot-task] claimed task {claimed.task_id}{repo_tag}",
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
                    # ``repo`` (first entry, "" if absent) is kept for
                    # existing consumers and log output; ``repos`` is the
                    # full backend-supplied list — may be empty or hold
                    # multiple entries.  Neither is enforced here; both
                    # are informational pass-through for downstream
                    # plugins that want per-job repo context.
                    "repo": claimed.repo,
                    "repos": claimed.repos,
                    "messages": claimed.messages,
                },
            )

            ok = dispatcher.dispatch(job)
            if not ok:
                print(
                    f"[hivemoot-task] dispatch failed for {claimed.task_id}",
                    file=sys.stderr, flush=True,
                )
            # Either way, immediately try claiming the next task —
            # backlog should drain as fast as the agent can run.

    def stop(self) -> None:
        self._stop_event.set()
