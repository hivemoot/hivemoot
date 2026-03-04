#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-task %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

load_provider_secrets
load_secret_from_file HIVEMOOT_AGENT_TOKEN

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

run_once_script="${RUN_ONCE_SCRIPT:-/opt/hivemoot-agent/scripts/run-once.sh}"
workspace_root="${WORKSPACE_ROOT:-/workspace}"
log_dir="${LOG_DIR:-${workspace_root}/runs}"

claim_url="${AGENT_TASK_CLAIM_URL:-}"
execute_base_url="${AGENT_TASK_EXECUTE_BASE_URL:-}"

task_id="${AGENT_TASK_ID:-}"
task_prompt="${AGENT_TASK_PROMPT:-}"
task_repo="${TARGET_REPO:-}"
target_repo_preset="$task_repo"

executor_token="${HIVEMOOT_AGENT_TOKEN:-}"

if [ -z "$executor_token" ]; then
  echo "Missing task executor token. Set HIVEMOOT_AGENT_TOKEN or HIVEMOOT_AGENT_TOKEN_FILE." >&2
  exit 1
fi

request_task_claim() {
  local response_file=""
  local status=""
  local repos_count=""

  if [ -z "$claim_url" ]; then
    return 1
  fi

  response_file="$(mktemp)"
  status="$(curl -sS -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${executor_token}" \
    -H 'Content-Type: application/json' \
    "$claim_url")"

  if [ "$status" = "204" ]; then
    rm -f "$response_file"
    log "No pending task available"
    exit 0
  fi

  if [ "$status" != "200" ]; then
    echo "Task claim failed with status ${status}" >&2
    sed 's/^/[claim] /' "$response_file" >&2 || true
    rm -f "$response_file"
    exit 1
  fi

  task_id="$(jq -r '.task.task_id // empty' < "$response_file")"
  task_prompt="$(jq -r '.task.prompt // empty' < "$response_file")"

  repos_count="$(jq -r '(.task.repos | length) // 0' < "$response_file")"
  if [ "$repos_count" -ne 1 ]; then
    echo "Claimed task must contain exactly one repo, got ${repos_count}." >&2
    rm -f "$response_file"
    exit 1
  fi

  task_repo="$(jq -r '.task.repos[0] // empty' < "$response_file")"
  if [ -n "$target_repo_preset" ] && [ "$task_repo" != "$target_repo_preset" ]; then
    echo "Claimed task repo ${task_repo} does not match TARGET_REPO ${target_repo_preset}." >&2
    rm -f "$response_file"
    exit 1
  fi

  if [ -z "$execute_base_url" ]; then
    execute_base_url="${claim_url%/claim}"
  fi

  rm -f "$response_file"
}

build_execute_url() {
  if [ -n "$execute_base_url" ] && [ -n "$task_id" ]; then
    printf '%s/%s/execute' "${execute_base_url%/}" "$task_id"
    return 0
  fi

  return 1
}

post_task_update() {
  local action="$1"
  local message="${2:-}"
  local update_url=""
  local payload=""
  local response_file=""
  local status=""

  if ! update_url="$(build_execute_url)"; then
    log "Task update skipped: execute URL is not configured"
    return 0
  fi

  case "$action" in
    progress)
      payload="$(jq -n --arg action "progress" --arg progress "$message" '{action: $action, progress: $progress}')"
      ;;
    complete)
      payload="$(jq -n --arg action "complete" --arg result "$message" '{action: $action, result: $result}')"
      ;;
    fail)
      payload="$(jq -n --arg action "fail" --arg error "$message" '{action: $action, error: $error}')"
      ;;
    timeout)
      payload='{"action":"timeout"}'
      ;;
    *)
      echo "Unsupported task action: ${action}" >&2
      return 1
      ;;
  esac

  response_file="$(mktemp)"
  status="$(curl -sS -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${executor_token}" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$update_url")"

  if [ "$status" != "200" ]; then
    log "Task update failed: action=${action} status=${status}"
    sed 's/^/[task-update] /' "$response_file" >&2 || true
    rm -f "$response_file"
    return 1
  fi

  rm -f "$response_file"
  return 0
}

if [ -z "$task_id" ] || [ -z "$task_prompt" ] || [ -z "$task_repo" ]; then
  if [ -n "$claim_url" ]; then
    request_task_claim
  fi
fi

if [ -z "$task_id" ] || [ -z "$task_prompt" ] || [ -z "$task_repo" ]; then
  echo "Task context is incomplete. Require AGENT_TASK_ID + AGENT_TASK_PROMPT + TARGET_REPO or AGENT_TASK_CLAIM_URL." >&2
  exit 1
fi

result_path="${workspace_root}/task-output/${task_id}/result.md"

validate_target_repo "$task_repo"

# Task mode always starts fresh context to avoid cross-task bleed.
export SESSION_RESUME=0
unset AGENT_SESSION_KEY || true

# Preserve system guardrails from AGENT_PROMPT_FILE/default and inject task
# details as user instructions through AGENT_EXTRA_PROMPT.
base_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
task_prompt_block="$(cat <<TASK_PROMPT
# Queen Task

You are executing a delegated Queen task for a human user.

## Task ID
${task_id}

## Task
${task_prompt}

## Instructions
- Focus only on this task.
- Be precise and concise.
- Write your final answer in markdown.
- If blocked, clearly explain what prevented completion.
TASK_PROMPT
)"

if [ -n "$base_extra_prompt" ]; then
  export AGENT_EXTRA_PROMPT="${base_extra_prompt}

${task_prompt_block}"
else
  export AGENT_EXTRA_PROMPT="$task_prompt_block"
fi

export TARGET_REPO="$task_repo"
# Keep run-task and run-once on the same log path even when LOG_DIR
# is not pre-set in the environment.
export LOG_DIR="$log_dir"

post_task_update progress "Task ${task_id} claimed. Starting execution." || true

preexisting_logs_file="$(mktemp)"
if [ -d "$log_dir" ]; then
  for candidate_log in "$log_dir"/*.log; do
    [ -f "$candidate_log" ] || continue
    printf '%s\n' "$candidate_log" >> "$preexisting_logs_file"
  done
fi

run_exit_code=0
if "$run_once_script"; then
  run_exit_code=0
else
  run_exit_code=$?
fi

latest_log=""
if [ -d "$log_dir" ]; then
  for candidate_log in "$log_dir"/*.log; do
    [ -f "$candidate_log" ] || continue
    if grep -Fxq "$candidate_log" "$preexisting_logs_file"; then
      continue
    fi
    if [ -z "$latest_log" ] || [ "$candidate_log" -nt "$latest_log" ]; then
      latest_log="$candidate_log"
    fi
  done
fi
rm -f "$preexisting_logs_file"

mkdir -p "$(dirname "$result_path")"
{
  echo "# Task Result"
  echo
  echo "- task_id: ${task_id}"
  echo "- repo: ${task_repo}"
  echo "- provider: ${AGENT_PROVIDER:-unknown}"
  echo "- exit_code: ${run_exit_code}"
  echo

  if [ "$run_exit_code" -eq 0 ]; then
    echo "Execution finished successfully."
  elif [ "$run_exit_code" -eq 124 ]; then
    echo "Execution timed out."
  else
    echo "Execution failed."
  fi

  if [ -n "$latest_log" ] && [ -f "$latest_log" ]; then
    echo
    echo "## Log Tail"
    echo
    echo '```text'
    tail -n 200 "$latest_log"
    echo '```'
  fi
} > "$result_path"

max_result_bytes=100000
result_payload="$(cat "$result_path")"
if [ "$(printf '%s' "$result_payload" | wc -c | tr -d ' ')" -gt "$max_result_bytes" ]; then
  result_payload="$(printf '%s' "$result_payload" | head -c "$max_result_bytes")

[truncated: exceeded ${max_result_bytes} bytes]"
fi

if [ "$run_exit_code" -eq 0 ]; then
  post_task_update complete "$result_payload" || true
elif [ "$run_exit_code" -eq 124 ]; then
  post_task_update timeout "" || true
else
  post_task_update fail "Task execution failed with exit code ${run_exit_code}" || true
fi

log "Task run finished: task_id=${task_id} exit_code=${run_exit_code} result_path=${result_path}"
exit "$run_exit_code"
