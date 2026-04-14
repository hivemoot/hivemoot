#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: ${label}" >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: ${label}" >&2
    echo "  expected to find: ${needle}" >&2
    echo "  actual: ${haystack}" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: ${label}" >&2
    echo "  expected to not find: ${needle}" >&2
    echo "  actual: ${haystack}" >&2
    exit 1
  fi
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "Expected file to contain: $needle" >&2
    echo "Actual file ($file):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "assertion failed"
  fi
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq -- "$needle" "$file"; then
    echo "Expected file to NOT contain: $needle" >&2
    echo "Actual file ($file):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "assertion failed"
  fi
}

echo "Running task-mode regression checks"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

mock_bin="${tmp_root}/bin"
mkdir -p "$mock_bin"

cat > "${mock_bin}/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_format=""
url=""
data_payload=""
headers=""
response_body=""
read_headers_from_stdin=0
header_source="argv"

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
    -H)
      if [ "${2:-}" = "@-" ]; then
        read_headers_from_stdin=1
        header_source="stdin"
      else
        if [ -n "$headers" ]; then
          headers="${headers}|$2"
        else
          headers="$2"
        fi
      fi
      shift 2
      ;;
    -X)
      shift 2
      ;;
    -s|-S|-sS)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

if [ "$read_headers_from_stdin" -eq 1 ]; then
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    if [ -n "$headers" ]; then
      headers="${headers}|${line}"
    else
      headers="${line}"
    fi
  done
fi

printf 'URL=%s DATA=%s HEADERS=%s HEADER_SOURCE=%s\n' \
  "$url" "$data_payload" "$headers" "$header_source" >> "${MOCK_CURL_CALLS:?}"

response_body="${MOCK_CURL_BODY-}"
if [ -z "$response_body" ]; then
  response_body='{}'
fi

if [ -n "$output_file" ]; then
  printf '%s' "$response_body" > "$output_file"
fi

printf '%s' "${MOCK_CURL_STATUS:-200}"
MOCK_CURL
chmod +x "${mock_bin}/curl"

export PATH="${mock_bin}:$PATH"
export REPO_ROOT="$repo_root"

log() {
  :
}

# shellcheck source=scripts/lib-classify.sh
. "$repo_root/scripts/lib-classify.sh"
# shellcheck source=controller/triggers/common.sh
. "$repo_root/controller/triggers/common.sh"
# shellcheck source=controller/triggers/hivemoot-task.sh
. "$repo_root/controller/triggers/hivemoot-task.sh"

if ! command -v task_id_is_valid >/dev/null 2>&1; then
  task_id_is_valid() {
    return 0
  }
fi

if ! command -v repo_name_is_valid >/dev/null 2>&1; then
  repo_name_is_valid() {
    return 0
  }
fi

reset_task_globals() {
  controller_reset_trigger_job_context
  controller_trigger_background_pid=""
  task_execute_base_url="https://api.example.com/api/tasks"
  task_executor_token="shared-token"
  task_heartbeat_interval_seconds=1
  export MOCK_CURL_STATUS=200
  export MOCK_CURL_BODY='{}'
}

run_entrypoint_task_workload_case() {
  local case_dir="${tmp_root}/entrypoint"
  local token_file="${case_dir}/agent-token"
  local env_snapshot="${case_dir}/env.log"
  local mock_run_once="${case_dir}/mock-run-once.sh"

  mkdir -p "$case_dir"
  printf '%s' 'ghs_worker_token' > "$token_file"
  chmod 600 "$token_file"

  cat > "$mock_run_once" <<'RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail
printf 'AGENT_GITHUB_TOKEN=%s\n' "${AGENT_GITHUB_TOKEN:-}" > "${MOCK_ENV_SNAPSHOT:?}"
printf 'AGENT_GITHUB_TOKEN_FILE=%s\n' "${AGENT_GITHUB_TOKEN_FILE:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf 'AGENT_WORKLOAD=%s\n' "${AGENT_WORKLOAD:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf 'TARGET_REPO=%s\n' "${TARGET_REPO:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf 'AGENT_TASK_ID=%s\n' "${AGENT_TASK_ID:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
printf 'AGENT_EXTRA_PROMPT=%s\n' "${AGENT_EXTRA_PROMPT:-}" >> "${MOCK_ENV_SNAPSHOT:?}"
RUN_ONCE
  chmod +x "$mock_run_once"

  env \
    HOME="${case_dir}/home" \
    AGENT_IDENTITY="hivemoot-agent" \
    AGENT_WORKLOAD="hivemoot-task" \
    AGENT_DRIVER="once" \
    AGENT_PROVIDER="claude" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01_FILE="$token_file" \
    AGENT_TASK_ID="task-123" \
    AGENT_EXTRA_PROMPT="Execute delegated task" \
    TARGET_REPO="owner/repo" \
    WORKLOAD_DIR="${repo_root}/workloads/hivemoot-task" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    DRIVER_DIR="${repo_root}/drivers" \
    KERNEL_DIR="${repo_root}/scripts" \
    RUN_ONCE_SCRIPT="$mock_run_once" \
    MOCK_ENV_SNAPSHOT="$env_snapshot" \
    bash "$repo_root/scripts/entrypoint.sh"

  assert_file_contains "$env_snapshot" "AGENT_GITHUB_TOKEN="
  assert_file_contains "$env_snapshot" "AGENT_GITHUB_TOKEN_FILE=${token_file}"
  assert_file_contains "$env_snapshot" "AGENT_WORKLOAD=hivemoot-task"
  assert_file_contains "$env_snapshot" "TARGET_REPO=owner/repo"
  assert_file_contains "$env_snapshot" "AGENT_TASK_ID=task-123"
  assert_file_contains "$env_snapshot" "AGENT_EXTRA_PROMPT=Execute delegated task"

  echo "PASS: single-run task workload uses explicit once driver"
}

run_prepare_job_session_key_case() {
  local case_dir="${tmp_root}/prepare-session"
  mkdir -p "${case_dir}/workspace-a" "${case_dir}/workspace-b" "${case_dir}/workspace-c"

  reset_task_globals
  controller_trigger_prepare_job__hivemoot_task \
    "job-a" "owner/repo" "worker" "${case_dir}/workspace-a" "unused-home" "claude" \
    "task-alpha" "Inspect queue behavior" "claim-a" "" "" ""
  assert_eq "task:task-alpha" "$controller_trigger_prepared_session_key" "default task session key"
  assert_contains "$controller_trigger_prepared_extra_prompt" "task-alpha" "default prompt includes task id"
  assert_contains "$controller_trigger_prepared_extra_prompt" "Inspect queue behavior" "default prompt includes task prompt"

  reset_task_globals
  controller_trigger_prepare_job__hivemoot_task \
    "job-b" "owner/repo" "worker" "${case_dir}/workspace-b" "unused-home" "claude" \
    "task-beta" "Inspect queue behavior" "claim-b" "" "" ""
  assert_eq "task:task-beta" "$controller_trigger_prepared_session_key" "second task gets independent session key"
  if [ "$controller_trigger_prepared_session_key" = "task:task-alpha" ]; then
    fail "task session keys must stay isolated by task id"
  fi

  reset_task_globals
  controller_trigger_prepare_job__hivemoot_task \
    "job-c" "owner/repo" "worker" "${case_dir}/workspace-c" "unused-home" "claude" \
    "task-gamma" "Inspect queue behavior" "claim-c" "" "" "mention-thread:123"
  assert_eq "mention-thread:123" "$controller_trigger_prepared_session_key" "explicit session key override"

  echo "PASS: task prepare_job isolates session keys by task id"
}

run_conversation_context_case() {
  local case_dir="${tmp_root}/conversation-context"
  local task_messages_json='[{"role":"user","content":"Original task details","created_at":"2026-03-05T03:00:00.000Z"},{"role":"system","content":"Task reopened by user","created_at":"2026-03-05T03:05:00.000Z"}]'
  local messages_file=""

  mkdir -p "${case_dir}/workspace"

  reset_task_globals
  controller_trigger_prepare_job__hivemoot_task \
    "job-msg" "owner/repo" "worker" "${case_dir}/workspace" "unused-home" "claude" \
    "task-msg" "Use complete timeline context" "claim-msg" "$task_messages_json" "Controller context line 1" ""

  messages_file="${case_dir}/workspace/task-input/task-msg/messages.json"
  [ -f "$messages_file" ] || fail "expected task messages file to be created"
  assert_file_contains "$messages_file" '"role":"user"'
  assert_file_contains "$messages_file" '"content":"Original task details"'
  assert_contains "$controller_trigger_prepared_extra_prompt" "Controller context line 1" "base extra prompt preserved"
  assert_contains "$controller_trigger_prepared_extra_prompt" "## Conversation Context" "conversation context header rendered"
  assert_contains "$controller_trigger_prepared_extra_prompt" "Original task details" "conversation context includes first message"
  assert_contains "$controller_trigger_prepared_extra_prompt" "Task reopened by user" "conversation context includes reopened message"

  echo "PASS: task prepare_job renders conversation context into the extra prompt"
}

run_task_claim_header_source_case() {
  local case_dir="${tmp_root}/claim-task"
  export MOCK_CURL_CALLS="${case_dir}/curl.log"
  mkdir -p "$case_dir"
  : > "$MOCK_CURL_CALLS"

  reset_task_globals
  task_claim_url="https://api.example.com/api/tasks/claim"
  MOCK_CURL_BODY="$(
    jq -cn \
      --arg task_id "task-claim-direct" \
      --arg prompt "Inspect queue behavior" \
      --arg repo "owner/repo" \
      --arg claim_token "claim-token-direct" \
      '{task: {task_id: $task_id, prompt: $prompt, repos: [$repo]}, claim_token: $claim_token, messages: []}'
  )"
  export MOCK_CURL_BODY

  if ! claim_next_task; then
    fail "expected claim_next_task to succeed"
  fi

  assert_eq "task-claim-direct" "$claimed_task_id" "claim_next_task captures task id"
  assert_eq "claim-token-direct" "$claimed_task_claim_token" "claim_next_task captures claim token"
  assert_eq "owner/repo" "$claimed_task_repo" "claim_next_task captures repo"
  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/claim"
  assert_file_contains "$MOCK_CURL_CALLS" 'Authorization: Bearer shared-token'
  assert_file_contains "$MOCK_CURL_CALLS" 'HEADER_SOURCE=stdin'

  echo "PASS: task claims send auth headers through stdin"
}

run_claim_token_header_case() {
  local case_dir="${tmp_root}/claim-token"
  export MOCK_CURL_CALLS="${case_dir}/curl.log"
  mkdir -p "$case_dir"
  : > "$MOCK_CURL_CALLS"

  reset_task_globals
  post_task_update_from_controller "task-header" "claim-token-123" progress "Working" >/dev/null

  assert_file_contains "$MOCK_CURL_CALLS" "URL=https://api.example.com/api/tasks/task-header/execute"
  assert_file_contains "$MOCK_CURL_CALLS" 'DATA={"action":"progress","progress":"Working"}'
  assert_file_contains "$MOCK_CURL_CALLS" 'Authorization: Bearer shared-token'
  assert_file_contains "$MOCK_CURL_CALLS" 'X-Task-Claim-Token: claim-token-123'
  assert_file_contains "$MOCK_CURL_CALLS" 'HEADER_SOURCE=stdin'

  echo "PASS: task updates forward X-Task-Claim-Token to the execute endpoint"
}

run_heartbeat_lifecycle_case() {
  local case_dir="${tmp_root}/heartbeat"
  export MOCK_CURL_CALLS="${case_dir}/curl.log"
  mkdir -p "$case_dir"
  : > "$MOCK_CURL_CALLS"

  reset_task_globals
  task_heartbeat_interval_seconds=1
  start_task_heartbeat_loop_from_controller "task-heartbeat" "claim-token-heartbeat"
  sleep 2
  stop_background_loop_pid "$controller_trigger_background_pid"
  controller_trigger_background_pid=""

  assert_file_contains "$MOCK_CURL_CALLS" 'URL=https://api.example.com/api/tasks/task-heartbeat/execute'
  assert_file_contains "$MOCK_CURL_CALLS" 'DATA={"action":"heartbeat"}'
  assert_file_contains "$MOCK_CURL_CALLS" 'X-Task-Claim-Token: claim-token-heartbeat'
  assert_file_contains "$MOCK_CURL_CALLS" 'HEADER_SOURCE=stdin'

  echo "PASS: task heartbeat loop emits authenticated heartbeat updates"
}

run_codex_auth_detection_case() {
  local case_dir="${tmp_root}/codex-auth-detect"
  local log_invalid="${case_dir}/invalid.jsonl"
  local log_nested="${case_dir}/nested.jsonl"
  local log_message="${case_dir}/message.jsonl"
  local log_turn_failed="${case_dir}/turn-failed.jsonl"

  mkdir -p "$case_dir"

  cat > "$log_invalid" <<'LOG'
{"type":"error","code":"invalid_api_key","message":"Incorrect API key provided"}
LOG
  assert_eq "invalid_api_key" "$(detect_codex_auth_error "$log_invalid")" "codex top-level auth code"

  cat > "$log_nested" <<'LOG'
{"type":"error","error":{"code":"refresh_token_reused","message":"Refresh token has already been used"}}
LOG
  assert_eq "refresh_token_reused" "$(detect_codex_auth_error "$log_nested")" "codex nested auth code"

  cat > "$log_message" <<'LOG'
{"type":"error","message":"Unauthorized"}
LOG
  assert_eq "auth_error" "$(detect_codex_auth_error "$log_message")" "codex message-only auth detection"

  cat > "$log_turn_failed" <<'LOG'
{"type":"turn.failed","error":{"message":"Invalid API key"}}
LOG
  assert_eq "auth_error" "$(detect_codex_auth_error "$log_turn_failed")" "codex turn.failed auth detection"

  echo "PASS: codex auth detection covers structured and message-only errors"
}

run_codex_auth_promotion_case() {
  local case_dir="${tmp_root}/codex-auth-promotion"
  local log_file="${case_dir}/codex-auth.jsonl"
  local workspace="${case_dir}/workspace"
  local result_path="${workspace}/task-output/task-codex-auth/result.md"
  local status=0

  mkdir -p "$workspace"
  export MOCK_CURL_CALLS="${case_dir}/curl.log"
  : > "$MOCK_CURL_CALLS"

  cat > "$log_file" <<'LOG'
{"type":"thread.started","thread_id":"auth-thread"}
{"type":"error","code":"invalid_api_key","message":"Incorrect API key provided"}
LOG

  reset_task_globals
  if handle_task_job_result "task-codex-auth" "owner/repo" "codex" 0 "$log_file" "$workspace" "claim-token-auth" ""; then
    fail "codex auth error should be promoted to failure"
  else
    status=$?
  fi

  assert_eq "1" "$status" "codex auth promotion exit code"
  [ -f "$result_path" ] || fail "expected result artifact for codex auth promotion case"
  assert_file_contains "$result_path" "Provider authentication failed: invalid_api_key"
  assert_file_contains "$MOCK_CURL_CALLS" 'DATA={"action":"fail","error":"Provider authentication failed: invalid_api_key"}'
  assert_file_contains "$MOCK_CURL_CALLS" 'X-Task-Claim-Token: claim-token-auth'
  assert_file_contains "$MOCK_CURL_CALLS" 'URL=https://api.example.com/api/tasks/task-codex-auth/execute'
  assert_file_contains "$MOCK_CURL_CALLS" 'HEADER_SOURCE=stdin'
  assert_file_not_contains "$MOCK_CURL_CALLS" '"action":"complete"'

  echo "PASS: codex auth errors are promoted from success logs into task failures"
}

run_entrypoint_task_workload_case
run_prepare_job_session_key_case
run_conversation_context_case
run_task_claim_header_source_case
run_claim_token_header_case
run_heartbeat_lifecycle_case
run_codex_auth_detection_case
run_codex_auth_promotion_case
