"""hivemoot.dev task API client — internal to the hivemoot_task plugin.

All requests use stdlib ``urllib`` (no third-party deps).  The bearer
token never leaves the process — it's read from file or env once and
attached as an ``Authorization`` header per request.

Endpoints:
    POST {AGENT_TASK_CLAIM_URL}                    → claim_next_task()
    POST {execute_base}/{task_id}/execute          → post_update()
        actions: heartbeat | progress | complete | fail | timeout

A backend that returns 204 (no task) is the steady state — handled
specially in ``claim_next_task`` so the trigger loop can treat it as
"poll again later" rather than an error.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


# Path-safe identifier guards.  Matches the deleted shell's
# task_id_is_valid (`shared/lib.sh:236`) and repo_name_is_valid
# (`shared/lib.sh:93`) so a backend that emits malformed values can't
# turn the per-task sidecar path into a directory traversal vector.
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


# Heartbeat / claim-poll requests must never stall the trigger loop.
# A slow or down backend should fail fast and the next tick will retry.
DEFAULT_TIMEOUT_SECS = 10


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow HTTP redirects so the bearer token is never
    forwarded to a redirect target (would leak Authorization)."""

    def http_error_301(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(
            req.full_url, code,
            f"redirect not followed (would leak Authorization): {msg}",
            headers, fp,
        )

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


_OPENER = urllib.request.build_opener(_NoRedirectHandler)


# ── Data shape ─────────────────────────────────────────────────────


@dataclass
class ClaimedTask:
    """Normalized form of a successful claim response."""

    task_id: str
    prompt: str
    repo: str
    claim_token: str
    messages: list[dict]


# ── Token resolution ───────────────────────────────────────────────


def resolve_executor_token(config_token_file: str = "") -> str:
    """Resolve the bearer token from explicit arg, env file, or env raw.

    Order: explicit token-file → ``HIVEMOOT_AGENT_TOKEN_FILE`` env →
    ``HIVEMOOT_AGENT_TOKEN`` env (raw).  Missing/unreadable files fall
    through silently — the caller decides whether no-auth is fatal.

    Mutual exclusion: when both ``HIVEMOOT_AGENT_TOKEN_FILE`` and
    ``HIVEMOOT_AGENT_TOKEN`` env vars are set, the file wins but a
    warning is logged so the operator notices the misconfiguration
    rather than silently shipping a stale token.  Matches the project-
    wide guard in ``cli/hivemoot_agent/worker.py:_resolve_secret_value``.
    """
    env_file = os.environ.get("HIVEMOOT_AGENT_TOKEN_FILE", "")
    env_raw = os.environ.get("HIVEMOOT_AGENT_TOKEN", "")
    if env_file and env_raw:
        print(
            "[hivemoot-task] both HIVEMOOT_AGENT_TOKEN_FILE and "
            "HIVEMOOT_AGENT_TOKEN are set; using the file. Unset one "
            "to silence this warning.",
            file=sys.stderr, flush=True,
        )

    candidate_files = [config_token_file, env_file]
    for path in candidate_files:
        if not path:
            continue
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            continue

    return env_raw.strip()


# ── Low-level request helper ──────────────────────────────────────


def _post(
    url: str,
    payload: dict,
    bearer: str,
    claim_token: str = "",
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> tuple[int, dict | None, bytes]:
    """POST a JSON payload.  Returns (status, parsed_body_or_none, raw_body).

    Body is parsed as JSON when possible; on parse failure ``None`` is
    returned and the raw bytes are kept so callers can log.
    """
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"bad URL scheme: {url}")

    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    if claim_token:
        req.add_header("X-Task-Claim-Token", claim_token)

    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = None
            return resp.status, parsed, raw
    except urllib.error.HTTPError as exc:
        raw = b""
        try:
            raw = exc.read()
        except Exception:
            pass
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = None
        return exc.code, parsed, raw


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
    status, parsed, raw = _post(claim_url, {}, bearer, timeout=timeout)

    if status == 204:
        return None

    if status != 200:
        raise RuntimeError(
            f"claim returned status {status}: {raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("claim response was not a JSON object")

    task = parsed.get("task") or {}
    task_id = str(task.get("task_id", "")).strip()
    prompt = str(task.get("prompt", "")).strip()
    claim_token = str(parsed.get("claim_token", "")).strip()

    repos = task.get("repos")
    if not isinstance(repos, list) or len(repos) != 1:
        raise RuntimeError(
            f"claim response must contain exactly one repo, got "
            f"{repos!r}"
        )
    repo = str(repos[0]).strip()

    messages = parsed.get("messages") or []
    if not isinstance(messages, list):
        messages = []

    if not task_id or not prompt or not repo or not claim_token:
        raise RuntimeError(
            "claim response missing required fields "
            "(task_id/prompt/repo/claim_token)"
        )

    # Path-safety guards on backend-supplied identifiers — these end
    # up in filesystem paths (sidecar, runs/<task_id>) and session
    # keys.  Reject obvious traversal attempts at the boundary.
    if not _is_valid_task_id(task_id):
        raise RuntimeError(f"claim returned invalid task_id format: {task_id!r}")
    if not _is_valid_repo(repo):
        raise RuntimeError(f"claim returned invalid repo format: {repo!r}")

    return ClaimedTask(
        task_id=task_id,
        prompt=prompt,
        repo=repo,
        claim_token=claim_token,
        messages=messages,
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
        status, _parsed, _raw = _post(
            _execute_url(execute_base, task_id),
            body,
            bearer,
            claim_token=claim_token,
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
