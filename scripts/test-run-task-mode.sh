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

assert_file_starts_with() {
  local file="$1"
  local expected="$2"
  local first_line=""
  first_line="$(head -n 1 "$file")"
  if [ "$first_line" != "$expected" ]; then
    echo "Expected first line: $expected" >&2
    echo "Actual first line: $first_line" >&2
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
printf '%s\n' "AGENT_PROMPT_FILE=${AGENT_PROMPT_FILE:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_EXTRA_PROMPT_START" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "${AGENT_EXTRA_PROMPT:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "AGENT_EXTRA_PROMPT_END" >> "${MOCK_ENV_SNAPSHOT:?}"
printf '%s\n' "called" >> "${MOCK_RUN_ONCE_CALLS:?}"
if [ -n "${MOCK_RUN_ONCE_LOG_JSONL_FILE:-}" ]; then
  cat "${MOCK_RUN_ONCE_LOG_JSONL_FILE}" > "${LOG_DIR}/mock-run.log"
elif [ -n "${MOCK_RUN_ONCE_LOG_TEXT:-}" ]; then
  printf '%s' "$MOCK_RUN_ONCE_LOG_TEXT" > "${LOG_DIR}/mock-run.log"
else
  cat > "${LOG_DIR}/mock-run.log" <<'LOG'
mock provider output line 1
mock provider output line 2
LOG
fi
if [ -n "${CODEX_ANSWER_FILE:-}" ] && [ -n "${MOCK_CODEX_ANSWER_CONTENT:-}" ]; then
  mkdir -p "$(dirname "$CODEX_ANSWER_FILE")"
  printf '%s' "$MOCK_CODEX_ANSWER_CONTENT" > "$CODEX_ANSWER_FILE"
fi
if [ "${MOCK_RUN_ONCE_SLEEP_SECS:-0}" -gt 0 ]; then
  sleep "${MOCK_RUN_ONCE_SLEEP_SECS}"
fi
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
headers=""

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
      if [ "$1" = "-H" ]; then
        if [ -n "$headers" ]; then
          headers="${headers}|$2"
        else
          headers="$2"
        fi
      fi
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

printf 'URL=%s DATA=%s HEADERS=%s\n' "$url" "$data_payload" "$headers" >> "${MOCK_CURL_CALLS:?}"

status="200"
body='{}'
default_claim_body='{"task":{"task_id":"claim-task-1","prompt":"Analyze the repo","repos":["owner/repo"]},"claim_token":"claim-token-default"}'

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
export AGENT_PROVIDER="claude"

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
    AGENT_TASK_CLAIM_TOKEN="claim-token-direct" \
    AGENT_TASK_ID="task-abc" \
    AGENT_TASK_PROMPT="Find auth regressions" \
    TARGET_REPO="owner/repo" \
    SESSION_RESUME=1 \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "# Task Result"
  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "TARGET_REPO=owner/repo"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "SESSION_RESUME=0"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "system/task.md"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Find auth regressions"
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/task-abc/execute"
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-direct"
  assert_file_contains "$MOCK_CURL_CALLS" '"action": "progress"'
  assert_file_contains "$MOCK_CURL_CALLS" '"action": "complete"'
}

run_case_preserves_explicit_prompt_override() {
  local case_dir="${tmp_root}/case-explicit-prompt-override"
  local result_path="${case_dir}/workspace/task-output/task-custom-prompt/result.md"
  local custom_prompt="${case_dir}/custom.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  printf 'custom system prompt\n' > "$custom_prompt"

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
    AGENT_TASK_ID="task-custom-prompt" \
    AGENT_TASK_PROMPT="Use my custom system prompt" \
    TARGET_REPO="owner/repo" \
    AGENT_PROMPT_FILE="$custom_prompt" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "AGENT_PROMPT_FILE=${custom_prompt}"
  assert_file_not_contains "$MOCK_ENV_SNAPSHOT" "system/task.md"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Use my custom system prompt"
}

run_case_direct_env_messages_file() {
  local case_dir="${tmp_root}/case-direct-messages-file"
  local result_path="${case_dir}/workspace/task-output/task-msg-file/result.md"
  local messages_file="${case_dir}/messages.json"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  cat > "$messages_file" <<'JSON'
[
  {"role":"user","content":"Original task details","created_at":"2026-03-05T03:00:00.000Z"},
  {"role":"system","content":"Task reopened by user","created_at":"2026-03-05T03:05:00.000Z"}
]
JSON

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
    AGENT_TASK_CLAIM_TOKEN="claim-token-msg-file" \
    AGENT_TASK_ID="task-msg-file" \
    AGENT_TASK_PROMPT="Use complete timeline context" \
    AGENT_TASK_MESSAGES_FILE="$messages_file" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "## Conversation Context"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Original task details"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Task reopened by user"
}

run_case_claim_mode() {
  local case_dir="${tmp_root}/case-claim"
  local result_path="${case_dir}/workspace/task-output/claimed-42/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="task"
  export MOCK_CLAIM_BODY='{"task":{"task_id":"claimed-42","prompt":"Inspect queue behavior","repos":["owner/claimed"]},"claim_token":"claim-token-42","messages":[{"role":"user","content":"Original prompt from user","created_at":"2026-03-05T03:00:00.000Z"},{"role":"system","content":"Task was reopened","created_at":"2026-03-05T03:05:00.000Z"}]}'
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
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-42"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "TARGET_REPO=owner/claimed"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "AGENT_TIMEOUT_SECONDS=333"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "## Conversation Context"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Original prompt from user"
  assert_file_contains "$MOCK_ENV_SNAPSHOT" "Task was reopened"
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
  export MOCK_CLAIM_BODY='{"task":{"task_id":"claimed-99","prompt":"Inspect queue behavior","repos":["owner/claimed"]},"claim_token":"claim-token-99"}'
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

run_case_claim_missing_token() {
  local case_dir="${tmp_root}/case-claim-missing-token"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="task"
  export MOCK_CLAIM_BODY='{"task":{"task_id":"claimed-no-token","prompt":"Inspect queue behavior","repos":["owner/claimed"]}}'
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_CLAIM_URL="https://api.example.com/api/tasks/claim" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when claim response omits claim_token"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Claimed task response missing claim_token."
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute when claim token is missing"
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
    AGENT_TASK_CLAIM_TOKEN="claim-token-shared" \
    AGENT_TASK_ID="task-token-check" \
    AGENT_TASK_PROMPT="Check shared token fallback" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/task-token-check/execute"
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-shared"
}

run_case_emits_heartbeat_updates() {
  local case_dir="${tmp_root}/case-heartbeat-updates"
  local result_path="${case_dir}/workspace/task-output/task-heartbeat/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_SLEEP_SECS=2
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS=1 \
    AGENT_TASK_CLAIM_TOKEN="claim-token-heartbeat" \
    AGENT_TASK_ID="task-heartbeat" \
    AGENT_TASK_PROMPT="Emit task heartbeat while running" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "Execution finished successfully."
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-heartbeat"
  assert_file_contains "$MOCK_CURL_CALLS" '"action":"heartbeat"'
  unset MOCK_RUN_ONCE_SLEEP_SECS
}

run_case_requires_agent_token() {
  local case_dir="${tmp_root}/case-missing-token"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN= \
    HIVEMOOT_AGENT_TOKEN_FILE= \
    AGENT_TASK_ID="task-no-token" \
    AGENT_TASK_PROMPT="Check missing token" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when HIVEMOOT_AGENT_TOKEN is missing"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Missing task executor token."
}

run_case_rejects_invalid_heartbeat_interval() {
  local case_dir="${tmp_root}/case-invalid-heartbeat-interval"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS="abc" \
    AGENT_TASK_ID="task-invalid-heartbeat" \
    AGENT_TASK_PROMPT="Check invalid heartbeat interval" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail for invalid AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS"
  fi

  assert_file_contains "${case_dir}/stderr.log" "AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS must be a non-negative integer."
}

run_case_rejects_missing_claim_token_when_execute_enabled() {
  local case_dir="${tmp_root}/case-missing-claim-token"
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
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN= \
    AGENT_TASK_ID="task-missing-claim-token" \
    AGENT_TASK_PROMPT="Claim token should be required" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when execute URL is set but claim token is missing"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Task claim token is required when execute URL is configured."
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
  assert_file_contains "$result_path" "## Debug Log Tail"
  assert_file_contains "$result_path" "mock provider output line 1"
}

run_case_codex_result_extraction() {
  local case_dir="${tmp_root}/case-codex-result-extraction"
  local result_path="${case_dir}/workspace/task-output/task-codex/result.md"
  local codex_log="${case_dir}/codex.jsonl"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  cat > "$codex_log" <<'LOG'
{"type":"thread.started","thread_id":"8f26b0d2-cbf8-4f17-a48e-aef76f95f2de"}
{"type":"item.completed","item":{"type":"agent_message","text":"## Final Answer\n\n- alpha\n- beta"}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}
LOG

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_JSONL_FILE="$codex_log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-generic-a" \
    AGENT_TASK_ID="task-codex" \
    AGENT_TASK_PROMPT="Return markdown answer" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="codex" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## Final Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## Final Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-generic-a"
  assert_file_not_contains "$MOCK_CURL_CALLS" "thread.started"
  unset MOCK_RUN_ONCE_LOG_JSONL_FILE
}

run_case_codex_result_extraction_fallback() {
  local case_dir="${tmp_root}/case-codex-result-fallback"
  local result_path="${case_dir}/workspace/task-output/task-codex-fallback/result.md"
  local codex_log="${case_dir}/codex-empty.jsonl"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  cat > "$codex_log" <<'LOG'
{"type":"thread.started","thread_id":"8f26b0d2-cbf8-4f17-a48e-aef76f95f2de"}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}
LOG

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_JSONL_FILE="$codex_log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-generic-b" \
    AGENT_TASK_ID="task-codex-fallback" \
    AGENT_TASK_PROMPT="Return markdown answer" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="codex" \
    bash scripts/run-task.sh

  assert_file_contains "$result_path" "could not be extracted from Codex logs"
  assert_file_contains "$MOCK_CURL_CALLS" "could be extracted from Codex JSON logs"
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-generic-b"
  unset MOCK_RUN_ONCE_LOG_JSONL_FILE
}

run_case_codex_result_extraction_with_malformed_lines() {
  local case_dir="${tmp_root}/case-codex-result-malformed"
  local result_path="${case_dir}/workspace/task-output/task-codex-malformed/result.md"
  local codex_log="${case_dir}/codex-malformed.jsonl"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  cat > "$codex_log" <<'LOG'
{"type":"thread.started","thread_id":"8f26b0d2-cbf8-4f17-a48e-aef76f95f2de"}
not-json-line
{"type":"item.completed","item":{"type":"agent_message","text":"## First Answer\n\n- old"}}
{broken-json
{"type":"item.completed","item":{"type":"agent_message","text":"## Final Answer\n\n- fresh"}}
LOG

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_JSONL_FILE="$codex_log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-generic-c" \
    AGENT_TASK_ID="task-codex-malformed" \
    AGENT_TASK_PROMPT="Return markdown answer" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="codex" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## Final Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## Final Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "X-Task-Claim-Token: claim-token-generic-c"
  assert_file_not_contains "$MOCK_CURL_CALLS" "not-json-line"
  unset MOCK_RUN_ONCE_LOG_JSONL_FILE
}

run_case_rejects_traversal_task_id() {
  local case_dir="${tmp_root}/case-traversal-task-id"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID="../../pwned" \
    AGENT_TASK_PROMPT="Traversal attempt" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when AGENT_TASK_ID contains path separators"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Invalid task_id"
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute on invalid task_id"
  fi
  # Confirm no artifact was written outside task-output
  if find "${case_dir}/workspace" -name "result.md" | grep -qv "task-output"; then
    fail "result.md written outside task-output subtree"
  fi
}

run_case_rejects_dotdot_task_id() {
  local case_dir="${tmp_root}/case-dotdot-task-id"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_ID=".." \
    AGENT_TASK_PROMPT="Dotdot attempt" \
    TARGET_REPO="owner/repo" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when AGENT_TASK_ID is '..'"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Invalid task_id"
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute on invalid task_id"
  fi
}

run_case_rejects_slash_in_claimed_task_id() {
  local case_dir="${tmp_root}/case-claim-slash-task-id"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_CLAIM_MODE="task"
  export MOCK_CLAIM_BODY='{"task":{"task_id":"bad/id","prompt":"Slash in id","repos":["owner/repo"]},"claim_token":"claim-token-bad-id"}'
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  if env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    TARGET_REPO= \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_CLAIM_URL="https://api.example.com/api/tasks/claim" \
    bash scripts/run-task.sh >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log"
  then
    fail "run-task should fail when claimed task_id contains a slash"
  fi

  assert_file_contains "${case_dir}/stderr.log" "Invalid task_id"
  if [ -s "$MOCK_RUN_ONCE_CALLS" ]; then
    fail "run-once should not execute when claimed task_id is invalid"
  fi
}

run_case_codex_sidecar_result() {
  local case_dir="${tmp_root}/case-codex-sidecar"
  local result_path="${case_dir}/workspace/task-output/task-codex-sidecar/result.md"
  local codex_log="${case_dir}/codex-jsonl-bg.jsonl"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  cat > "$codex_log" <<'LOG'
{"type":"item.completed","item":{"type":"agent_message","text":"## JSONL Answer\n\n- old"}}
LOG

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_JSONL_FILE="$codex_log"
  export MOCK_CODEX_ANSWER_CONTENT="## Sidecar Answer

- alpha
- beta"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-codex-sidecar" \
    AGENT_TASK_ID="task-codex-sidecar" \
    AGENT_TASK_PROMPT="Return answer via sidecar" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="codex" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## Sidecar Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## Sidecar Answer"
  assert_file_not_contains "$MOCK_CURL_CALLS" "## JSONL Answer"
  unset MOCK_RUN_ONCE_LOG_JSONL_FILE
  unset MOCK_CODEX_ANSWER_CONTENT
}

run_case_codex_sidecar_fallback_to_jsonl() {
  local case_dir="${tmp_root}/case-codex-sidecar-fallback"
  local result_path="${case_dir}/workspace/task-output/task-codex-sf/result.md"
  local codex_log="${case_dir}/codex-fallback.jsonl"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"
  cat > "$codex_log" <<'LOG'
{"type":"item.completed","item":{"type":"agent_message","text":"## JSONL Answer\n\n- fresh"}}
LOG

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_JSONL_FILE="$codex_log"
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-codex-sf" \
    AGENT_TASK_ID="task-codex-sf" \
    AGENT_TASK_PROMPT="Return answer via JSONL fallback" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="codex" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## JSONL Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## JSONL Answer"
  unset MOCK_RUN_ONCE_LOG_JSONL_FILE
}

run_case_gemini_text_result() {
  local case_dir="${tmp_root}/case-gemini-text"
  local result_path="${case_dir}/workspace/task-output/task-gemini-text/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_TEXT="## Gemini Answer

Some text response."
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-gemini-text" \
    AGENT_TASK_ID="task-gemini-text" \
    AGENT_TASK_PROMPT="Return text answer" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="gemini" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## Gemini Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## Gemini Answer"
  assert_file_not_contains "$MOCK_CURL_CALLS" "thread.started"
  unset MOCK_RUN_ONCE_LOG_TEXT
}

run_case_claude_text_result() {
  local case_dir="${tmp_root}/case-claude-text"
  local result_path="${case_dir}/workspace/task-output/task-claude-text/result.md"
  mkdir -p "$case_dir/logs" "$case_dir/workspace"

  export MOCK_CURL_CALLS="${case_dir}/curl-calls.log"
  export MOCK_ENV_SNAPSHOT="${case_dir}/env-snapshot.log"
  export MOCK_RUN_ONCE_CALLS="${case_dir}/run-once-calls.log"
  export MOCK_RUN_ONCE_LOG_TEXT="## Claude Answer

Some text response."
  : > "$MOCK_CURL_CALLS"
  : > "$MOCK_RUN_ONCE_CALLS"

  env \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    LOG_DIR="${case_dir}/logs" \
    HIVEMOOT_AGENT_TOKEN="task-token" \
    AGENT_TASK_EXECUTE_BASE_URL="https://api.example.com/api/tasks" \
    AGENT_TASK_CLAIM_TOKEN="claim-token-claude-text" \
    AGENT_TASK_ID="task-claude-text" \
    AGENT_TASK_PROMPT="Return text answer" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="claude" \
    bash scripts/run-task.sh

  assert_file_starts_with "$result_path" "## Claude Answer"
  assert_file_contains "$MOCK_CURL_CALLS" "## Claude Answer"
  unset MOCK_RUN_ONCE_LOG_TEXT
}

run_case_direct_env
run_case_preserves_explicit_prompt_override
run_case_direct_env_messages_file
run_case_claim_mode
run_case_slot_token_file_bridge
run_case_claim_repo_mismatch
run_case_claim_missing_token
run_case_no_pending_task
run_case_no_stale_log_tail_on_early_failure
run_case_rejects_invalid_repo
run_case_allows_dot_leading_repo_segment
run_case_shared_agent_token
run_case_emits_heartbeat_updates
run_case_requires_agent_token
run_case_rejects_invalid_heartbeat_interval
run_case_rejects_missing_claim_token_when_execute_enabled
run_case_default_log_dir_when_unset
run_case_codex_result_extraction
run_case_codex_result_extraction_fallback
run_case_codex_result_extraction_with_malformed_lines
run_case_rejects_traversal_task_id
run_case_rejects_dotdot_task_id
run_case_rejects_slash_in_claimed_task_id
run_case_codex_sidecar_result
run_case_codex_sidecar_fallback_to_jsonl
run_case_gemini_text_result
run_case_claude_text_result

echo "PASS: task mode checks"
