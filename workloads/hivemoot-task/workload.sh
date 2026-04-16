#!/usr/bin/env bash
# hivemoot-task workload — execute a specific delegated task on a GitHub repo.
#
# The task lifecycle (claim, heartbeat, result extraction, reporting) is
# controller-owned. This file defines only the worker-side workload hooks.
#
# ── Hooks ─────────────────────────────────────────────────────────
#   workload_integration     — "github"
#   workload_setup           — deps, auth, clone, git config
#   workload_preflight       — validate prompt files
#   workload_build_prompt    — task-focused system instructions
#   workload_user_message    — default user instruction
#   workload_skills_dir      — shared Hivemoot skill pack
# ──────────────────────────────────────────────────────────────────

WORKLOAD_TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_HIVEMOOT_GITHUB_DIR="$(cd "${WORKLOAD_TASK_DIR}/../../cli/hivemoot_agent/plugins_builtin/hivemoot_github" && pwd)"
INTEGRATION_DIR="${INTEGRATION_DIR:-/opt/hivemoot-agent/integrations}"

# Integration: GitHub auth + clone (tasks also operate on GitHub repos)
# shellcheck source=integrations/github/setup.sh
. "${INTEGRATION_DIR}/github/setup.sh"

# ── Manifest ──────────────────────────────────────────────────────

workload_integration()    { printf '%s' "github"; }

# ── Lifecycle hooks ───────────────────────────────────────────────

workload_setup() {
  github_check_deps
  github_auth
  github_clone_or_sync
  github_configure_git
}

workload_preflight() {
  local failures=0
  if [ ! -f "${WORKLOAD_TASK_DIR}/prompts/task.md" ]; then
    echo "Pre-flight: task prompt not found: ${WORKLOAD_TASK_DIR}/prompts/task.md" >&2
    failures=$((failures + 1))
  fi
  return "$failures"
}

workload_build_prompt() {
  cat "${WORKLOAD_TASK_DIR}/prompts/task.md"
  printf '\nTarget repository: %s\nLocal repository path: %s\n' "$target_repo" "$repo_dir"
  if [ "$clone_depth" -gt 0 ]; then
    printf "\nTechnical notes:\n- Shallow clone (depth %s). git log/blame are truncated. Run 'git fetch --unshallow' if you need full history.\n" "$clone_depth"
  fi
}

workload_user_message() {
  printf '%s' "Execute the task described in your instructions."
}

workload_skills_dir() {
  printf '%s' "${PLUGIN_HIVEMOOT_GITHUB_DIR}/skills"
}
