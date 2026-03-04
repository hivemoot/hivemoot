#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    echo "Expected file to contain: $needle" >&2
    echo "Actual file ($file):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "assertion failed"
  fi
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq "$needle" "$file"; then
    echo "Expected file to NOT contain: $needle" >&2
    echo "Actual file ($file):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "assertion failed"
  fi
}

echo "Running task mode checks"

tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

mock_bin="${tmp_root}/bin"
mkdir -p "$mock_bin"

mock_run_once="${tmp_root}/mock-run-once.sh"
cat > "$mock_run_once" <<'RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${LOG_DIR:?}"
printf '%s\n' "TARGET_REPO=${TARGET_REPO:-}" > "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "LOG_DIR=${LOG_DIR:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_TIMEOUT_SECONDS=${AGENT_TIMEOUT_SECONDS:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "SESSION_RESUME=${SESSION_RESUME:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_GITHUB_TOKEN=${AGENT_GITHUB_TOKEN:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_GITHUB_TOKEN_FILE=${AGENT_GITHUB_TOKEN_FILE:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_EXTRA_PROMPT_START" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "${AGENT_EXTRA_PROMPT:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_EXTRA_PROMPT_END" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "called" >> "${MOCK_RUN_ONCE_CALLS:?}"
cat > "${LOG_DIR}/mock-run.log" <<'LOG'
mock provider output line 1
mock provider output line 2
LOG
exit "${MOCK_RUN_ONCE_EXIT_CODE:-0}"
RUN_ONCE
chmod +x "$mock_run_once"

mock_run_once_fail_early="${tmp_root}/mock-run-once-fail-early.sh"
cat > "$mock_run_once_fail_early" <<'RUN_ONCE_FAIL_EARLY'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "called" >> "${MOCK_RUN_ONCE_CALLS:?}"
exit 1
RUN_ONCE_FAIL_EARLY
chmod +x "$mock_run_once_fail_early"

mock_curl="${mock_bin}/curl"
cat > "$mock_curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_format=""
data_payload=""
url=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      write_format="$2"
      shift 2
      ;;
    -d)
      data_payload="$2"
      shift 2
      ;;
    -X|-H)
      shift 2
      ;;
    -s|-S)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

printf 'URL=%s DATA=%s\n' "$url" "$data_payload" >> "${MOCK_CURL_CALLS:?}"

status="200"
body='{}'
default_claim_body='{"task":{"task_id":"claim-task-1","prompt":"Analyze the repo","repos":["owner/repo"]}}'

case "$url" in
  */claim)
    if [ "${MOCK_CLAIM_MODE:-task}" = "empty" ]; then
      status="204"
      body=''
    else
      status="200"
      body="${MOCK_CLAIM_BODY:-$default_claim_body}"
    fi
    ;;
  */execute)
    status="${MOCK_EXECUTE_STATUS:-200}"
    body='{"task":{"status":"ok"}}'
    ;;
esac

if [ -n "$output_file" ]; then
  printf '%s' "$body" > "$output_file"
fi

if [ -n "$write_format" ]; then
  printf '%s' "$status"
else
  printf '%s' "$body"
fi
MOCK_CURL
chmod +x "$mock_curl"

export PATH="${mock_bin}:$PATH"

run_case_direct_env() {
  local case_dir="${tmp_root}/case-direct"
  local result_path="${case_dir}/workspace/task-output/task-abc/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_ID="task-abc" \
    AGENT_TASK_PROMPT="Find auth regressions" \
    TARGET_REPO="owner/repo" \
    SESSION_RESUME=1 \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "# Task Result"
  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "TARGET_REPO=owner/repo"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "SESSION_RESUME=0"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Find auth regressions"
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/task-abc/execute"
  assert_file_contains "$MOCK_CURL_CALLS" '"action": "progress"'
  assert_file_contains "$MOCK_CURL_CALLS" '"action": "complete"'
}

run_case_claim_mode() {
  local case_dir="${tmp_root}/case-claim"
  local result_path="${case_dir}/workspace/task-output/claimed-42/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="task"
  export MOCK_CLAIM_BODY='{"task":{"task_id":"claimed-42","prompt":"Inspect queue behavior","repos":["owner/claimed"]}}'
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    TARGET_REPO= \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TIMEOUT_SECONDS="333" \
    AGENT_TASK_CLAIM_URL="https://api.example.com/api/tasks/claim" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/claim"
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/claimed-42/execute"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "TARGET_REPO=owner/claimed"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "AGENT_TIMEOUT_SECONDS=333"
}

run_case_slot_token_file_bridge() {
  local case_dir="${tmp_root}/case-slot-token-file-bridge"
  local result_path="${case_dir}/workspace/task-output/task-slot-file/result.md"
  local slot_token_file="${case_dir}/secrets/slot-token"
  mkdir -p "$case_dir/logs" "$case_dir/workspace" "$(dirname "$slot_token_file")"
  printf '%s' "ghs_slot_file_token" > "$slot_token_file"
  chmod 600 "$slot_token_file"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="task-slot-file" \
    AGENT_TASK_PROMPT="Verify slot token file bridge" \
    TARGET_REPO="owner/repo" \
    AGENT_GITHUB_TOKEN= \
    AGENT_GITHUB_TOKEN_FILE= \
    AGENT_GITHUB_TOKEN_01= \
    AGENT_GITHUB_TOKEN_01_FILE="$slot_token_file" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "AGENT_GITHUB_TOKEN="
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "AGENT_GITHUB_TOKEN_FILE=${slot_token_file}"
}

run_case_claim_repo_mismatch() {
  local case_dir="${tmp_root}/case-claim-repo-mismatch"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="task"
  export MOCK_CLAIM_BODY='{"task":{"task_id":"claimed-99","prompt":"Inspect queue behavior","repos":["owner/claimed"]}}'
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    TARGET_REPO="owner/expected" \
    AGENT_TASK_CLAIM_URL="https://api.example.com/api/tasks/claim" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when claimed repo mismatches TARGET_REPO"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Claimed task repo owner/claimed does not match TARGET_REPO owner/expected."
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute on claim repo mismatch"
  fi
}

run_case_no_pending_task() {
  local case_dir="${tmp_root}/case-empty"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="empty"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    TARGET_REPO= \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_CLAIM_URL="https://api.example.com/api/tasks/claim" \
    bash scripts/run-task.sh

  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute when claim returns 204"
  fi
}

run_case_no_stale_log_tail_on_early_failure() {
  local case_dir="${tmp_root}/case-no-stale-tail"
  local result_path="${case_dir}/workspace/task-output/task-fail/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"
  printf '%s\n' "OLD SECRET LINE" > "${case_dir}/logs/old.log"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once_fail_early" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="task-fail" \
    AGENT_TASK_PROMPT="Check failure path" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when run-once exits non-zero"
  fi

  assert_file_contains "$result_path" "Execution failed."
  assert_file_not_contains "$result_path" "OLD SECRET LINE"
  assert_file_not_contains "$result_path" "## Log Tail"
}

run_case_rejects_invalid_repo() {
  local case_dir="${tmp_root}/case-invalid-repo"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="task-invalid-repo" \
    AGENT_TASK_PROMPT="Reject traversal repo" \
    TARGET_REPO="../evil" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when TARGET_REPO is invalid"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Invalid TARGET_REPO: ../evil. Expected owner/repo."
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute when TARGET_REPO is invalid"
  fi
}

run_case_allows_dot_leading_repo_segment() {
  local case_dir="${tmp_root}/case-dot-leading-repo-segment"
  local result_path="${case_dir}/workspace/task-output/task-dot-repo/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="task-dot-repo" \
    AGENT_TASK_PROMPT="Allow dot-leading repo segment" \
    TARGET_REPO="owner/.github" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "TARGET_REPO=owner/.github"
}

run_case_shared_agent_token() {
  local case_dir="${tmp_root}/case-shared-agent-token"
  local result_path="${case_dir}/workspace/task-output/task-token-check/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="shared-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_ID="task-token-check" \
    AGENT_TASK_PROMPT="Check shared token fallback" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/task-token-check/execute"
}

run_case_requires_agent_token() {
  local case_dir="${tmp_root}/case-missing-token"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    AGENT_TASK_ID="task-no-token" \
    AGENT_TASK_PROMPT="Check missing token" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when HIVEMOOT_AGENT_TOKEN is missing"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Missing task executor token."
}

run_case_default_log_dir_when_unset() {
  local case_dir="${tmp_root}/case-default-log-dir"
  local result_path="${case_dir}/workspace/task-output/task-default-log-dir/result.md"
  mkdir -p "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    LOG_DIR= \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="task-default-log-dir" \
    AGENT_TASK_PROMPT="Verify default log dir wiring" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh

  assert_file_contains "$MOCK_ENV_SNAPSHOT" "LOG_DIR=${case_dir}/workspace/runs"
  assert_file_contains "$result_path" "## Log Tail"
  assert_file_contains "$result_path" "mock provider output line 1"
}

run_case_direct_env
run_case_claim_mode
run_case_slot_token_file_bridge
run_case_claim_repo_mismatch
run_case_no_pending_task
run_case_no_stale_log_tail_on_early_failure
run_case_rejects_invalid_repo
run_case_allows_dot_leading_repo_segment
run_case_shared_agent_token
run_case_requires_agent_token
run_case_default_log_dir_when_unset

echo "PASS: task mode checks"
