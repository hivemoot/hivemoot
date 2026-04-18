#!/usr/bin/env bash
# Deprecation stub — the host-side shell supervisor was retired per
# ADR-002 §Migration.  This file exists only so callers that still
# reference it (e.g. an unmigrated apiary fleet launcher) fail with a
# clear, actionable error instead of a cryptic "file not found."
#
# Remove this file and ``scripts/controller.sh`` once apiary has
# migrated its deploy scripts to daemon-mode containers.
set -euo pipefail

cat >&2 <<'EOF'
ERROR: controller/main.sh has been retired.

All triggers now run in-process inside ``hivemoot-agent run`` (daemon
mode).  Container supervision is the deployer's responsibility — one
long-lived daemon per agent role × repo, via systemd unit, docker
compose up -d, or your orchestrator of choice.

Migration:
  * systemd unit recipe: see README.md §Multi-agent deployments
  * Plugin architecture rationale: docs/adr/002-plugin-architecture.md
  * Example systemd ExecStart:
      /usr/bin/docker compose -f /opt/hivemoot-agent/docker-compose.yml \
        run --rm --name hivemoot-agent-<role>-<repo> hivemoot-agent

Legacy envs that no longer have effect: CONTROLLER_*, GLOBAL_*,
PERIODIC_INTERVAL_SECS, PERIODIC_JITTER_SECS, MAX_CONSECUTIVE_FAILURES,
PERIODIC_AGENT_FAILURE_BACKOFF_*, WORKER_IMAGE, QUEUE_*,
WORKSPACE_TTL_SECS, ORPHAN_RECOVERY_GRACE_SECS.
EOF

exit 64
