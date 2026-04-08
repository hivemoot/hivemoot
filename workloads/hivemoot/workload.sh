#!/usr/bin/env bash
# hivemoot workload — autonomous Hivemoot GitHub contributions.
#
# ── Hooks ─────────────────────────────────────────────────────────
#   workload_integration     — "github"
#   workload_setup           — deps, auth, clone, git config
#   workload_preflight       — validate prompt + skill files
#   workload_build_prompt    — autonomous contribution instructions + role
#   workload_user_message    — default user instruction
#   workload_skills_dir      — path to skills/
# ──────────────────────────────────────────────────────────────────

WORKLOAD_GITHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="${INTEGRATION_DIR:-/opt/hivemoot-agent/integrations}"

# Integration: GitHub auth + clone
# shellcheck source=integrations/github/setup.sh
. "${INTEGRATION_DIR}/github/setup.sh"
# shellcheck source=workloads/hivemoot/role.sh
. "${WORKLOAD_GITHUB_DIR}/role.sh"

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
  if [ ! -f "${WORKLOAD_GITHUB_DIR}/prompts/autonomous.md" ]; then
    echo "Pre-flight: workload prompt not found: ${WORKLOAD_GITHUB_DIR}/prompts/autonomous.md" >&2
    failures=$((failures + 1))
  fi
  local skill_failures=0
  preflight_check_agent_skill_lists "$(workload_skills_dir)" || skill_failures=$?
  failures=$((failures + skill_failures))
  return "$failures"
}

workload_build_prompt() {
  local role_name="${hivemoot_buzz_role:-${AGENT_ID:-${AGENT_ID_01:-}}}"

  # Mode instructions
  cat "${WORKLOAD_GITHUB_DIR}/prompts/autonomous.md"

  # Role: personality and instructions from hivemoot CLI (workload concern).
  # Default to the selected agent slot id when no explicit override is set.
  if [ -n "$role_name" ]; then
    local role_prompt_block=""
    if role_prompt_block="$(resolve_role_prompt_block "$role_name" "$target_repo")"; then
      printf '\n\n%s\n\nHivemoot buzz role: %s\nUse this role value when running: hivemoot buzz --role %s\n' \
        "$role_prompt_block" "$role_name" "$role_name"
    else
      log "WARNING: role resolution failed for role=${role_name}; agent will run without role instructions"
    fi
  fi

  # Context
  printf '\nTarget repository: %s\nLocal repository path: %s\n' "$target_repo" "$repo_dir"
  if [ "$clone_depth" -gt 0 ]; then
    printf "\nTechnical notes:\n- Shallow clone (depth %s). git log/blame are truncated. Run 'git fetch --unshallow' if you need full history.\n" "$clone_depth"
  fi
}

workload_user_message() {
  printf '%s' "Make meaningful contributions to the repository according to your role instructions."
}

workload_skills_dir() {
  printf '%s' "${WORKLOAD_GITHUB_DIR}/skills"
}
