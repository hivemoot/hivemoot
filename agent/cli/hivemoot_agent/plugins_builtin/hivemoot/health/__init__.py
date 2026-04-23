"""Agent-health subsystem — heartbeats + per-run reports.

Contract: ``web/AGENT_HEALTH_CONTRACT.md``.

Two kinds of posts land at ``POST {base_url}/api/agent-health``:

  * Heartbeat (``outcome: "heartbeat"``) — periodic liveness signal
    sent by :class:`HealthHeartbeatTrigger` between runs.
  * Run report — dispatched from the plugin's ``on_job_finished``
    hook whenever a job completes.

Both payloads use the same bearer auth (``HIVEMOOT_AGENT_TOKEN`` /
``_FILE``) resolved by the parent plugin.
"""
