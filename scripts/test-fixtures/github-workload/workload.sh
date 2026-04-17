#!/usr/bin/env bash
# shellcheck disable=SC2154  # context vars come from the sourcing runtime.
# Minimal GitHub-integration workload used only by the shell-workload
# regression tests (test-plugin-loader-guards, test-target-repo-validation,
# test-path-input-validation). Production workflows use the Python plugin
# engine — see cli/hivemoot_agent/plugins_builtin/.

FIXTURE_WORKLOAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="${INTEGRATION_DIR:-/opt/hivemoot-agent/integrations}"

# shellcheck source=integrations/github/setup.sh
. "${INTEGRATION_DIR}/github/setup.sh"

workload_integration() { printf '%s' "github"; }

workload_setup() {
  validate_target_repo "${target_repo:-}"
}

workload_preflight() { return 0; }

workload_build_prompt() { printf '%s\n' "fixture workload prompt"; }

workload_user_message() { printf '%s' "fixture user message"; }

workload_skills_dir() { printf '%s' "${FIXTURE_WORKLOAD_DIR}/skills"; }
