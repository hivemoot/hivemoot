#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains_line() {
  local file="$1"
  local expected="$2"
  if ! grep -Fqx "$expected" "$file"; then
    echo "Expected line:" >&2
    echo "  $expected" >&2
    echo "Actual file (${file}):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "missing expected line"
  fi
}

setup_mock_bin() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "api" ]; then
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi

case "${2:-}" in
  user)
    echo '{"login":"mock-user"}'
    ;;
  installation)
    echo '{"id":1}'
    ;;
  repos/*)
    repo="${2#repos/}"
    printf '{"full_name":"%s"}\n' "$repo"
    ;;
  *)
    echo "unexpected gh api endpoint: ${2:-}" >&2
    exit 1
    ;;
esac
EOF_GH

  cat > "${mock_bin}/hivemoot" <<'EOF_HIVEMOOT'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --version)
    echo "hivemoot 0.0.0-test"
    ;;
  role)
    cat <<'JSON'
{"role":{"name":"worker","description":"Test role","instructions":"Do the work."},"onboarding":"Read the repo."}
JSON
    ;;
  *)
    echo "unexpected hivemoot invocation: $*" >&2
    exit 1
    ;;
esac
EOF_HIVEMOOT

  cat > "${mock_bin}/claude" <<'EOF_CLAUDE'
#!/usr/bin/env bash
exit 0
EOF_CLAUDE

  chmod +x "${mock_bin}/gh" "${mock_bin}/hivemoot" "${mock_bin}/claude"
}

run_periodic_interval_propagation_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

printf 'agent:%s\n' "${AGENT_ID:-unset}" >> "$MOCK_RESULT_FILE"
printf 'interval:%s\n' "${PERIODIC_INTERVAL_SECS:-unset}" >> "$MOCK_RESULT_FILE"
printf 'trigger:%s\n' "${RUN_TRIGGER_TYPE:-unset}" >> "$MOCK_RESULT_FILE"
exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_IDENTITY="hivemoot-agent" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    AGENT_WORKLOAD="messaging" \
    WORKLOAD_DIR="${repo_root}/workloads/messaging" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    SHARED_DIR="${repo_root}/shared" \
    KERNEL_DIR="${repo_root}/worker" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID="worker" \
    AGENT_TOKEN="token-1" \
    PERIODIC_INTERVAL_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in periodic propagation case"
  fi

  assert_file_contains_line "$result_file" "agent:worker"
  assert_file_contains_line "$result_file" "interval:1"
  assert_file_contains_line "$result_file" "trigger:scheduled"
  echo "PASS: periodic loop propagates single-agent worker context"
}

run_worker_rejects_controller_triggers_case() {
  local repo_root="$1"
  local case_dir="$2"
  local run_log="${case_dir}/run-loop.log"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  setup_mock_bin "${case_dir}/mock-bin"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_IDENTITY="hivemoot-agent" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    AGENT_WORKLOAD="messaging" \
    WORKLOAD_DIR="${repo_root}/workloads/messaging" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    SHARED_DIR="${repo_root}/shared" \
    KERNEL_DIR="${repo_root}/worker" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID="worker" \
    AGENT_TOKEN="token-1" \
    WATCH_MENTIONS="1" \
    PERIODIC_INTERVAL_SECS="2" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2
    fail "run-loop accepted controller-owned trigger env unexpectedly"
  fi

  if ! grep -Fq "Worker loop driver is periodic execution only" "$run_log"; then
    sed 's/^/  /' "$run_log" >&2
    fail "run-loop did not reject controller-owned trigger envs"
  fi

  echo "PASS: worker loop rejects controller-owned trigger envs"
}

run_legacy_slot_fallback_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

printf 'legacy-agent:%s\n' "${AGENT_ID:-unset}" >> "$MOCK_RESULT_FILE"
exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_IDENTITY="hivemoot-agent" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    AGENT_WORKLOAD="messaging" \
    WORKLOAD_DIR="${repo_root}/workloads/messaging" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    SHARED_DIR="${repo_root}/shared" \
    KERNEL_DIR="${repo_root}/worker" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID_01="worker-legacy" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    PERIODIC_INTERVAL_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in legacy fallback case"
  fi

  assert_file_contains_line "$result_file" "legacy-agent:worker-legacy"
  echo "PASS: periodic loop still accepts legacy slot fallback"
}

echo "Running run-loop execution checks"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
tmp_root="$(mktemp -d "${repo_root}/.tmp-run-loop-next-run.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

run_periodic_interval_propagation_case "$repo_root" "${tmp_root}/periodic-propagation"
run_worker_rejects_controller_triggers_case "$repo_root" "${tmp_root}/controller-trigger-rejection"
run_legacy_slot_fallback_case "$repo_root" "${tmp_root}/legacy-slot-fallback"

echo "PASS: run-loop execution checks"
