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

# Task mode runs a single agent. The controller passes credentials in the
# multi-agent slot format (AGENT_ID_01 / AGENT_GITHUB_TOKEN_01_FILE) but
# run-once.sh expects the bare AGENT_GITHUB_TOKEN_FILE.  Resolve slot 01
# into the bare form so run-once.sh can load it via load_secret_from_file.
if [ -z "${AGENT_GITHUB_TOKEN_FILE:-}" ] && [ -z "${AGENT_GITHUB_TOKEN:-}" ]; then
  if [ -n "${AGENT_GITHUB_TOKEN_01_FILE:-}" ]; then
    export AGENT_GITHUB_TOKEN_FILE="${AGENT_GITHUB_TOKEN_01_FILE}"
  elif [ -n "${AGENT_GITHUB_TOKEN_01:-}" ]; then
    export AGENT_GITHUB_TOKEN="${AGENT_GITHUB_TOKEN_01}"
  fi
fi

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
heartbeat_interval_seconds="${AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS:-45}"

task_id="${AGENT_TASK_ID:-}"
task_prompt="${AGENT_TASK_PROMPT:-}"
task_repo="${TARGET_REPO:-}"
task_claim_token="${AGENT_TASK_CLAIM_TOKEN:-}"
task_messages_file="${AGENT_TASK_MESSAGES_FILE:-}"
task_messages_tmp_file=""
target_repo_preset="$task_repo"

executor_token="${HIVEMOOT_AGENT_TOKEN:-}"

if [ -z "$executor_token" ]; then
  echo "Missing task executor token. Set HIVEMOOT_AGENT_TOKEN or HIVEMOOT_AGENT_TOKEN_FILE." >&2
  exit 1
fi

case "$heartbeat_interval_seconds" in
  ''|*[!0-9]*)
    echo "AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS must be a non-negative integer." >&2
    exit 1
    ;;
esac

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
  task_claim_token="$(jq -r '.claim_token // empty' < "$response_file")"
  task_messages_tmp_file="$(mktemp)"
  if ! jq -c '(.messages // []) | if type=="array" then . else [] end' < "$response_file" > "$task_messages_tmp_file"; then
    echo "Claimed task response has invalid messages payload." >&2
    rm -f "$response_file" "$task_messages_tmp_file"
    task_messages_tmp_file=""
    exit 1
  fi
  task_messages_file="$task_messages_tmp_file"

  repos_count="$(jq -r '(.task.repos | length) // 0' < "$response_file")"
  if [ "$repos_count" -ne 1 ]; then
    echo "Claimed task must contain exactly one repo, got ${repos_count}." >&2
    rm -f "$response_file"
    exit 1
  fi

  task_repo="$(jq -r '.task.repos[0] // empty' < "$response_file")"
  if [ -z "$task_claim_token" ]; then
    echo "Claimed task response missing claim_token." >&2
    rm -f "$response_file"
    exit 1
  fi
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

render_task_messages_block() {
  local messages_source_file="$1"

  if [ ! -f "$messages_source_file" ]; then
    echo "Task messages file not found: ${messages_source_file}" >&2
    return 1
  fi

  jq -r '
    if type != "array" then
      error("task messages payload must be an array")
    elif length == 0 then
      ""
    else
      "## Conversation Context\n"
      + "Use this complete timeline as additional context for follow-up/reopened work.\n\n"
      + (
          to_entries
          | map(
              "### Message " + ((.key + 1) | tostring)
              + " (" + ((.value.role // "unknown") | tostring)
              + " @ " + ((.value.created_at // "unknown") | tostring) + ")\n"
              + ((.value.content // "") | tostring)
            )
          | join("\n\n")
        )
    end
  ' "$messages_source_file"
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
  local -a curl_args=()

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
    heartbeat)
      payload='{"action":"heartbeat"}'
      ;;
    *)
      echo "Unsupported task action: ${action}" >&2
      return 1
      ;;
  esac

  response_file="$(mktemp)"
  curl_args=(
    -sS
    -o "$response_file"
    -w '%{http_code}'
    -X POST
    -H "Authorization: Bearer ${executor_token}"
    -H 'Content-Type: application/json'
  )
  if [ -n "$task_claim_token" ]; then
    curl_args+=( -H "X-Task-Claim-Token: ${task_claim_token}" )
  fi
  curl_args+=( -d "$payload" "$update_url" )
  status="$(curl "${curl_args[@]}")"

  if [ "$status" != "200" ]; then
    log "Task update failed: action=${action} status=${status}"
    sed 's/^/[task-update] /' "$response_file" >&2 || true
    rm -f "$response_file"
    return 1
  fi

  rm -f "$response_file"
  return 0
}

heartbeat_pid=""
stop_task_heartbeat_loop() {
  if [ -z "$heartbeat_pid" ]; then
    return 0
  fi

  if kill -0 "$heartbeat_pid" >/dev/null 2>&1; then
    kill "$heartbeat_pid" >/dev/null 2>&1 || true
  fi
  wait "$heartbeat_pid" 2>/dev/null || true
  heartbeat_pid=""
}

start_task_heartbeat_loop() {
  if [ "$heartbeat_interval_seconds" -le 0 ]; then
    return 0
  fi

  if ! build_execute_url >/dev/null; then
    return 0
  fi

  (
    while true; do
      sleep "$heartbeat_interval_seconds" || exit 0
      post_task_update heartbeat "" || true
    done
  ) &
  heartbeat_pid="$!"
}

trap '
  stop_task_heartbeat_loop
  if [ -n "$task_messages_tmp_file" ]; then
    rm -f "$task_messages_tmp_file"
    task_messages_tmp_file=""
  fi
' EXIT

if [ -z "$task_id" ] || [ -z "$task_prompt" ] || [ -z "$task_repo" ]; then
  if [ -n "$claim_url" ]; then
    request_task_claim
  fi
fi

if [ -z "$task_id" ] || [ -z "$task_prompt" ] || [ -z "$task_repo" ]; then
  echo "Task context is incomplete. Require AGENT_TASK_ID + AGENT_TASK_PROMPT + TARGET_REPO or AGENT_TASK_CLAIM_URL." >&2
  exit 1
fi

if build_execute_url >/dev/null && [ -z "$task_claim_token" ]; then
  echo "Task claim token is required when execute URL is configured. Set AGENT_TASK_CLAIM_TOKEN or use AGENT_TASK_CLAIM_URL claim flow." >&2
  exit 1
fi

validate_task_id "$task_id"
validate_target_repo "$task_repo"

result_path="${workspace_root}/task-output/${task_id}/result.md"

# Task mode always starts fresh context to avoid cross-task bleed.
export SESSION_RESUME=0
unset AGENT_SESSION_KEY || true

# Task mode uses the task prompt (AGENT_EXTRA_PROMPT) as its full instruction
# set — role resolution via `hivemoot role <name>` is not needed and would fail
# for dispatch-only agents like "attendant" that have no entry in the repo's
# hivemoot.yml.  Clear the role so run-once.sh skips role resolution.
unset HIVEMOOT_BUZZ_ROLE || true

# Task mode uses a focused system prompt by default, but preserves an explicit
# AGENT_PROMPT_FILE override for operators who provide their own system prompt.
if [ -z "${AGENT_PROMPT_FILE:-}" ]; then
  task_system_prompt="/opt/hivemoot-agent/prompts/system/task.md"
  if [ ! -f "$task_system_prompt" ]; then
    source_tree_system_prompt="${SCRIPT_DIR}/../prompts/system/task.md"
    if [ -f "$source_tree_system_prompt" ]; then
      task_system_prompt="$source_tree_system_prompt"
    fi
  fi
  if [ -f "$task_system_prompt" ]; then
    export AGENT_PROMPT_FILE="$task_system_prompt"
  fi
fi

# Preserve system guardrails from the default task prompt or an explicit
# AGENT_PROMPT_FILE override, and inject task details as user instructions.
base_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
task_prompt_template_default="/opt/hivemoot-agent/prompts/messages/task.md"
task_prompt_template="${AGENT_TASK_PROMPT_FILE:-$task_prompt_template_default}"
if [ ! -f "$task_prompt_template" ]; then
  # Source-tree runs (tests/local debugging) do not have /opt paths mounted.
  source_tree_prompt_template="${SCRIPT_DIR}/../prompts/messages/task.md"
  if [ -f "$source_tree_prompt_template" ]; then
    task_prompt_template="$source_tree_prompt_template"
  else
    echo "Task prompt template not found: ${task_prompt_template} (fallback checked: ${source_tree_prompt_template})" >&2
    exit 1
  fi
fi
# Substitute placeholders using safe bash parameter expansion — no eval,
# no external tools, and arbitrary content in task_prompt is handled safely.
task_prompt_block="$(cat "$task_prompt_template")"
task_prompt_block="${task_prompt_block//\$\{task_id\}/$task_id}"
task_prompt_block="${task_prompt_block//\$\{task_prompt\}/$task_prompt}"

task_messages_block=""
if [ -n "$task_messages_file" ]; then
  if ! task_messages_block="$(render_task_messages_block "$task_messages_file")"; then
    echo "Failed to parse task messages from ${task_messages_file}." >&2
    exit 1
  fi
fi

if [ -n "$task_messages_block" ]; then
  task_prompt_block="${task_prompt_block}

${task_messages_block}"
fi

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

# In task mode, Codex can write the final answer atomically to a sidecar file
# using --output-last-message, which is more reliable than JSONL log parsing.
# Set CODEX_ANSWER_FILE so run-once.sh can pass the flag to the provider.
if [ "${AGENT_PROVIDER:-unknown}" = "codex" ]; then
  codex_answer_file="${workspace_root}/task-output/${task_id}/codex-answer.md"
  mkdir -p "$(dirname "$codex_answer_file")"
  export CODEX_ANSWER_FILE="$codex_answer_file"
fi

preexisting_logs_file="$(mktemp)"
if [ -d "$log_dir" ]; then
  for candidate_log in "$log_dir"/*.log; do
    [ -f "$candidate_log" ] || continue
    printf '%s\n' "$candidate_log" >> "$preexisting_logs_file"
  done
fi

run_exit_code=0
start_task_heartbeat_loop
if "$run_once_script"; then
  run_exit_code=0
else
  run_exit_code=$?
fi
stop_task_heartbeat_loop

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

extract_codex_result_markdown() {
  local log_path="$1"
  local sidecar_path="${CODEX_ANSWER_FILE:-}"
  local encoded_message=""

  # Prefer the --output-last-message sidecar: written atomically by codex at
  # turn end, so it contains exactly the final assistant answer with no
  # transport-layer JSON noise.
  if [ -n "$sidecar_path" ] && [ -s "$sidecar_path" ]; then
    cat "$sidecar_path"
    return 0
  fi

  # Fall back to streaming JSONL extraction when sidecar is absent or empty.
  if [ ! -f "$log_path" ]; then
    return 0
  fi

  encoded_message="$(
    jq -Rr '
      fromjson?
      | select(.type=="item.completed")
      | .item
      | select(.type=="agent_message")
      | .text // empty
      | @base64
    ' "$log_path" | tail -n 1
  )"

  if [ -n "$encoded_message" ]; then
    printf '%s\n' "$encoded_message" | jq -Rr '@base64d'
  fi
}

# For Gemini and Claude in task mode, --output-format text makes the log the
# raw answer. Read it directly without any JSON parsing.
# Assumption: run-once.sh captures provider output via `2>&1 | tee -a "$log_file"`,
# so log_path contains both stdout and stderr. For text mode without --verbose,
# stderr is expected empty in practice for both CLIs, making the whole log safe
# to use as the result. If a future CLI change produces non-empty stderr in text
# mode, the prefix lines would appear in the posted result — revisit then.
extract_text_result_from_log() {
  local log_path="$1"
  if [ -f "$log_path" ] && [ -s "$log_path" ]; then
    cat "$log_path"
  fi
}

extract_task_result_markdown() {
  local provider_name="$1"
  local log_path="$2"

  case "$provider_name" in
    codex)
      extract_codex_result_markdown "$log_path"
      ;;
    gemini|claude)
      extract_text_result_from_log "$log_path"
      ;;
    *)
      return 0
      ;;
  esac
}

provider_name="${AGENT_PROVIDER:-unknown}"
task_result_markdown=""
if [ "$run_exit_code" -eq 0 ] && [ -n "$latest_log" ] && [ -f "$latest_log" ]; then
  task_result_markdown="$(extract_task_result_markdown "$provider_name" "$latest_log")"
fi

complete_payload=""
if [ "$run_exit_code" -eq 0 ]; then
  if [ -n "$task_result_markdown" ]; then
    complete_payload="$task_result_markdown"
  elif [ "$provider_name" = "codex" ]; then
    complete_payload="Task completed, but no agent markdown result could be extracted from Codex JSON logs. See local debug details in task-output/${task_id}/result.md."
  elif [ "$provider_name" = "gemini" ] || [ "$provider_name" = "claude" ]; then
    complete_payload="Task completed, but no output was captured from ${provider_name}. See local debug details in task-output/${task_id}/result.md."
  fi
fi

mkdir -p "$(dirname "$result_path")"
{
  if [ -n "$task_result_markdown" ]; then
    printf '%s\n' "$task_result_markdown"
    echo
  fi

  echo "# Task Result"
  echo
  echo "- task_id: ${task_id}"
  echo "- repo: ${task_repo}"
  echo "- provider: ${provider_name}"
  echo "- exit_code: ${run_exit_code}"

  if [ "$run_exit_code" -eq 0 ] && [ -z "$task_result_markdown" ] && [ "$provider_name" = "codex" ]; then
    echo
    echo "Execution finished, but the markdown result could not be extracted from Codex logs."
  elif [ "$run_exit_code" -eq 0 ] && [ -z "$task_result_markdown" ] && { [ "$provider_name" = "gemini" ] || [ "$provider_name" = "claude" ]; }; then
    echo
    echo "Execution finished, but no output was captured from ${provider_name}."
  elif [ "$run_exit_code" -eq 0 ]; then
    echo
    echo "Execution finished successfully."
  elif [ "$run_exit_code" -eq 124 ]; then
    echo
    echo "Execution timed out."
  else
    echo
    echo "Execution failed."
  fi

  if [ -n "$latest_log" ] && [ -f "$latest_log" ]; then
    echo
    echo "## Debug Log Tail"
    echo
    echo '```text'
    tail -n 200 "$latest_log"
    echo '```'
  fi
} > "$result_path"

max_result_bytes=100000
result_payload="$complete_payload"
if [ -z "$result_payload" ]; then
  result_payload="$(cat "$result_path")"
fi
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
