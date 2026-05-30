"""hivemoot.dev agent-health API client.

Thin wrapper around ``hivemoot.http.post_json`` that enforces the
subset of the AGENT_HEALTH_CONTRACT we currently emit:

  * Heartbeat — ``outcome: "heartbeat"`` liveness signal.
  * Run report — per-job outcome with duration + exit code.

Server-side validates strictly (unknown fields rejected, regex
guards on identifiers).  We truncate ``error`` to 256 chars to stay
within the contract without forcing callers to remember the limit.
"""

from __future__ import annotations

from hivemoot_agent.plugins_builtin.hivemoot.http import post_json


_ERROR_MAX_LEN = 256


def _endpoint(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/api/agent-health"


def post_heartbeat(
    base_url: str,
    bearer: str,
    *,
    agent_id: str,
    next_run_at: str = "",
) -> bool:
    """POST a heartbeat.  Returns True on 200.

    Health is a per-agent signal — keyed solely on ``agent_id``
    (one identity per container). No ``repo`` dimension.
    """
    payload: dict = {
        "agent_id": agent_id,
        "outcome": "heartbeat",
    }
    if next_run_at:
        payload["next_run_at"] = next_run_at
    status, _parsed, _raw = post_json(_endpoint(base_url), payload, bearer)
    return status == 200


def post_run_report(
    base_url: str,
    bearer: str,
    *,
    agent_id: str,
    run_id: str,
    outcome: str,
    duration_secs: int,
    consecutive_failures: int,
    exit_code: int | None = None,
    error: str = "",
    trigger: str = "",
    next_run_at: str = "",
) -> bool:
    """POST a run report.  Returns True on 200.

    Health is a per-agent signal — keyed solely on ``agent_id``.
    No ``repo`` dimension.

    ``outcome`` must be one of ``success`` | ``failure`` | ``timeout``.
    ``trigger`` (optional) must be one of ``scheduled`` | ``mention`` |
    ``manual`` | ``task``; pass empty to omit.
    """
    payload: dict = {
        "agent_id": agent_id,
        "run_id": run_id,
        "outcome": outcome,
        "duration_secs": duration_secs,
        "consecutive_failures": consecutive_failures,
    }
    if exit_code is not None:
        payload["exit_code"] = exit_code
    if error:
        payload["error"] = error[:_ERROR_MAX_LEN]
    if trigger:
        payload["trigger"] = trigger
    if next_run_at:
        payload["next_run_at"] = next_run_at
    status, _parsed, _raw = post_json(_endpoint(base_url), payload, bearer)
    return status == 200
