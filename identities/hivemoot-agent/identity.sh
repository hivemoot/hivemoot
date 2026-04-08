#!/usr/bin/env bash
# shellcheck disable=SC2034  # identity_resolve populates globals consumed by the worker runtime.
# hivemoot-agent identity — the default Hivemoot agent identity.
#
# ── Contract ──────────────────────────────────────────────────────
#
# IDENTITY HOOKS (called by the kernel before the workload):
#   identity_resolve  — set agent_name and agent_email
#   identity_prompt   — stdout: soul prompt (guardrails, style)
# ──────────────────────────────────────────────────────────────────

IDENTITY_HIVEMOOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

identity_resolve() {
  agent_name="${AGENT_GIT_NAME:-${AGENT_ID:-${AGENT_ID_01:-agent}}}"
  agent_email="${AGENT_GIT_EMAIL:-}"
}

identity_prompt() {
  cat "${IDENTITY_HIVEMOOT_DIR}/soul.md"
}
