"""hivemoot.dev delegated-task API client.

Two request surfaces:

    POST {claim_url}                      → claim_next_task()
    POST {execute_base}/{task_id}/execute → post_update() variants
        actions: heartbeat | progress | complete | fail | timeout

A backend that returns 204 (no task) is the steady state — handled
specially in ``claim_next_task`` so the trigger loop treats it as
"poll again later" rather than an error.

Transport and auth helpers are shared with the rest of the hivemoot
plugin in ``..http`` and ``..auth`` — this module only owns the
per-endpoint request shaping and response parsing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from hivemoot_agent.plugins_builtin.hivemoot.auth import resolve_agent_token
from hivemoot_agent.plugins_builtin.hivemoot.http import (
    DEFAULT_TIMEOUT_SECS,
    _NoRedirectHandler,
    _OPENER,
    post_json,
)

# Re-exported for tests that historically patched ``task_api._OPENER``
# / ``task_api._NoRedirectHandler``.  The shared http client moved
# to ``..http`` in the consolidation; these aliases point at the
# same objects so patch.object calls still route through them.
__all__ = (
    "ClaimedTask",
    "DEFAULT_TIMEOUT_SECS",
    "_NoRedirectHandler",
    "_OPENER",
    "claim_next_task",
    "post_complete",
    "post_fail",
    "post_heartbeat",
    "post_progress",
    "post_timeout",
    "post_update",
    "resolve_executor_token",
)


# Path-safe identifier guards.  A backend that emits malformed values
# must not turn the per-task sidecar path into a directory traversal
# vector — task_id and repo end up in filesystem paths downstream.
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$")


def _is_valid_task_id(value: str) -> bool:
    if value in ("", ".", ".."):
        return False
    return bool(_TASK_ID_RE.match(value))


def _is_valid_repo(value: str) -> bool:
    if not _REPO_RE.match(value):
        return False
    segment = value.split("/", 1)[1]
    return segment not in (".", "..")


# ── Data shape ─────────────────────────────────────────────────────


@dataclass
class ClaimedTask:
    """Normalized form of a successful claim response.

    ``repos`` carries the full repo list the backend sent (may be
    empty for generic repo-less tasks — "summarize governance",
    "draft RFC" — or contain multiple for cross-repo work).

    ``repo`` is a singular convenience = the first entry (or empty
    string).  Preserved for existing callers that stash it in
    ``Job.metadata["repo"]`` and for log messages that print one
    identifier.
    """

    task_id: str
    prompt: str
    repo: str
    claim_token: str
    messages: list[dict]
    repos: list[str] = field(default_factory=list)


# Re-export for any external callers that historically reached into
# this module for token resolution.  New code should import
# ``resolve_agent_token`` from ``hivemoot.auth`` directly.
resolve_executor_token = resolve_agent_token


# ── Claim ──────────────────────────────────────────────────────────


def claim_next_task(
    claim_url: str,
    bearer: str,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> ClaimedTask | None:
    """POST to the claim URL.

    Returns:
        ClaimedTask on a successful 200 with a well-formed body.
        None on 204 (no task available).

    Raises:
        RuntimeError on transport / API errors so the trigger loop's
        outer try/except can engage backoff.
    """
    status, parsed, raw = post_json(claim_url, {}, bearer, timeout=timeout)

    if status == 204:
        return None

    if status != 200:
        raise RuntimeError(
            f"claim returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("claim response was not a JSON object")

    task = parsed.get("task") or {}
    task_id = str(task.get("task_id", "")).strip()
    prompt = str(task.get("prompt", "")).strip()
    claim_token = str(parsed.get("claim_token", "")).strip()

    # ``repos`` is optional and may be empty: a task is a unit of work,
    # not a unit of code edit.  Each entry must pass the path-safety
    # guards because ``repo`` can end up in filesystem paths (codex
    # sidecar) and session keys downstream.
    repos_raw = task.get("repos")
    if repos_raw is None:
        repos: list[str] = []
    elif not isinstance(repos_raw, list):
        raise RuntimeError(
            f"claim response ``repos`` must be a list (or absent), got "
            f"{repos_raw!r}"
        )
    else:
        repos = [str(r).strip() for r in repos_raw]

    messages = parsed.get("messages") or []
    if not isinstance(messages, list):
        messages = []

    if not task_id or not prompt or not claim_token:
        raise RuntimeError(
            "claim response missing required fields "
            "(task_id/prompt/claim_token)"
        )

    if not _is_valid_task_id(task_id):
        raise RuntimeError(
            f"claim returned invalid task_id format: {task_id!r}"
        )
    for entry in repos:
        if not _is_valid_repo(entry):
            raise RuntimeError(
                f"claim returned invalid repo format: {entry!r}"
            )

    primary_repo = repos[0] if repos else ""

    return ClaimedTask(
        task_id=task_id,
        prompt=prompt,
        repo=primary_repo,
        claim_token=claim_token,
        messages=messages,
        repos=repos,
    )


# ── Per-task updates (heartbeat / progress / complete / fail / timeout) ──


def _execute_url(execute_base: str, task_id: str) -> str:
    base = execute_base.rstrip("/")
    return f"{base}/{task_id}/execute"


def post_update(
    execute_base: str,
    task_id: str,
    bearer: str,
    claim_token: str,
    action: str,
    payload: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> bool:
    """POST a task update.

    ``action`` selects the verb; ``payload`` supplies extra fields.
    Returns True on 200.  Best-effort: returns False on any non-200
    or transport error and lets the caller decide.
    """
    body: dict[str, Any] = {"action": action}
    if payload:
        body.update(payload)

    try:
        status, _parsed, _raw = post_json(
            _execute_url(execute_base, task_id),
            body,
            bearer,
            extra_headers=(
                {"X-Task-Claim-Token": claim_token} if claim_token else None
            ),
            timeout=timeout,
        )
    except Exception:
        return False

    return status == 200


def post_heartbeat(
    execute_base: str, task_id: str, bearer: str, claim_token: str,
) -> bool:
    return post_update(execute_base, task_id, bearer, claim_token, "heartbeat")


def post_progress(
    execute_base: str, task_id: str, bearer: str, claim_token: str,
    progress: str,
) -> bool:
    return post_update(
        execute_base, task_id, bearer, claim_token,
        "progress", {"progress": progress},
    )


def post_complete(
    execute_base: str, task_id: str, bearer: str, claim_token: str,
    result: str,
) -> bool:
    return post_update(
        execute_base, task_id, bearer, claim_token,
        "complete", {"result": result},
    )


def post_fail(
    execute_base: str, task_id: str, bearer: str, claim_token: str,
    error: str,
) -> bool:
    return post_update(
        execute_base, task_id, bearer, claim_token,
        "fail", {"error": error},
    )


def post_timeout(
    execute_base: str, task_id: str, bearer: str, claim_token: str,
) -> bool:
    return post_update(execute_base, task_id, bearer, claim_token, "timeout")
