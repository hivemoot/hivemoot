#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$file"; then
    echo "Expected to find: $expected" >&2
    echo "In file: $file" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "missing expected content"
  fi
}

assert_file_not_contains() {
  local file="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" "$file"; then
    echo "Did not expect to find: $unexpected" >&2
    echo "In file: $file" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "unexpected content found"
  fi
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [ "$expected" != "$actual" ]; then
    fail "${message} (expected=${expected} actual=${actual})"
  fi
}

setup_mock_docker() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/docker" <<'EOF_MOCK'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${MOCK_DOCKER_STATE_DIR:?MOCK_DOCKER_STATE_DIR is required}"
mkdir -p "$state_dir"

cmd="${1:-}"
shift || true

counter_file="${state_dir}/counter"
active_file="${state_dir}/active-container"
active_lock_dir="${state_dir}/active-container.lock"
run_log_file="${state_dir}/docker-run.log"
overlap_file="${state_dir}/overlap.log"

container_exited_file() {
  local container_id="${1:-}"
  printf '%s/%s.exited' "$state_dir" "$container_id"
}

mark_exited_from_args() {
  local arg=""
  local -a ids=()

  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --time|-t)
        shift
        if [ "$#" -gt 0 ]; then
          shift
        fi
        ;;
      -*)
        shift
        ;;
      *)
        ids+=("$arg")
        shift
        ;;
    esac
  done

  for arg in "${ids[@]}"; do
    : > "$(container_exited_file "$arg")"
  done
}

next_id() {
  local current=0
  if [ -f "$counter_file" ]; then
    current="$(cat "$counter_file")"
  fi
  current=$((current + 1))
  printf '%s' "$current" > "$counter_file"
  printf 'mock-container-%s' "$current"
}

case "$cmd" in
  run)
    # mkdir is atomic and keeps overlap detection deterministic under concurrency.
    if ! mkdir "$active_lock_dir" 2>/dev/null; then
      echo "overlap" >> "$overlap_file"
    fi

    printf '%s\n' "$*" >> "$run_log_file"

    container_id="$(next_id)"
    rm -f "$(container_exited_file "$container_id")"
    printf '%s\n' "$container_id" > "$active_file"
    printf '%s\n' "$container_id"
    ;;

  logs)
    container_id="${*: -1}"
    exited_file="$(container_exited_file "$container_id")"
    echo "mock log stream"
    while [ ! -f "$exited_file" ]; do
      sleep 0.1
    done
    ;;

  wait)
    container_id="${1:-}"
    if [ -z "$container_id" ] && [ -s "$active_file" ]; then
      container_id="$(cat "$active_file")"
    fi
    sleep "${MOCK_DOCKER_WAIT_SLEEP_SECS:-0}"
    if [ -n "$container_id" ]; then
      : > "$(container_exited_file "$container_id")"
    fi
    printf '%s\n' "${MOCK_DOCKER_WAIT_EXIT:-0}"
    ;;

  rm)
    mark_exited_from_args "$@"
    rm -f "$active_file"
    rmdir "$active_lock_dir" 2>/dev/null || true
    ;;

  ps)
    if [ -s "$active_file" ]; then
      cat "$active_file"
    fi
    ;;

  stop)
    mark_exited_from_args "$@"
    rm -f "$active_file"
    rmdir "$active_lock_dir" 2>/dev/null || true
    ;;

  *)
    echo "unexpected docker invocation: ${cmd} $*" >&2
    exit 1
    ;;
esac
EOF_MOCK

  chmod +x "${mock_bin}/docker"
}

setup_mock_hivemoot() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/hivemoot" <<'EOF_MOCK'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${MOCK_HIVEMOOT_STATE_DIR:?MOCK_HIVEMOOT_STATE_DIR is required}"
mkdir -p "$state_dir"

cmd="${1:-}"
shift || true

case "$cmd" in
  watch)
    printf '%s\n' "$*" >> "${state_dir}/watch.log"
    if [ "${MOCK_HIVEMOOT_WATCH_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    if [ -n "${MOCK_HIVEMOOT_WATCH_OUTPUT:-}" ]; then
      printf '%s\n' "${MOCK_HIVEMOOT_WATCH_OUTPUT}"
    fi
    ;;

  ack)
    ack_key="${1:-}"
    shift || true
    state_file=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --state-file)
          shift
          state_file="${1:-}"
          ;;
      esac
      shift || true
    done
    printf '%s|%s\n' "$ack_key" "$state_file" >> "${state_dir}/ack.log"
    if [ "${MOCK_HIVEMOOT_ACK_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    ;;

  *)
    echo "unexpected hivemoot invocation: ${cmd} $*" >&2
    exit 1
    ;;
esac
EOF_MOCK

  chmod +x "${mock_bin}/hivemoot"
}

run_success_case() {
  local repo_root="$1"
  local case_dir="$2"

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="1" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="2" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_ID_02="builder" \
    AGENT_GITHUB_TOKEN_02="token-2" \
    AGENT_TIMEOUT_SECONDS="120" \
    GIT_CLONE_DEPTH="1" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"

  if [ -s "${case_dir}/mock-state/overlap.log" ]; then
    fail "per-repo lock failed; detected overlapping worker launches"
  fi

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log"

  assert_file_contains "$run_log" "--cap-drop=ALL"
  assert_file_contains "$run_log" "--security-opt=no-new-privileges"
  assert_file_contains "$run_log" "--read-only"
  assert_file_contains "$run_log" "--tmpfs /tmp:size=2g,mode=1777"
  assert_file_contains "$run_log" "--tmpfs /usr/local/share/npm-global:size=1g"
  assert_file_contains "$run_log" "-e RUN_MODE=once"
  assert_file_contains "$run_log" "-e TARGET_REPO=owner/repo"
  assert_file_contains "$run_log" "-e JOB_ID="
  assert_file_contains "$run_log" "-e HIVEMOOT_CLI_UPDATE=skip"
  assert_file_contains "$run_log" "-e GIT_CLONE_DEPTH=1"

  shopt -s nullglob
  status_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/status)
  summary_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/summary)
  job_specs=("${case_dir}/workspace"/jobs/*/job.json)
  shopt -u nullglob

  assert_eq "2" "${#status_files[@]}" "expected one status file per agent"
  assert_eq "2" "${#summary_files[@]}" "expected one summary file per agent"
  assert_eq "2" "${#job_specs[@]}" "expected one job spec per agent"

  for status_file in "${status_files[@]}"; do
    assert_eq "completed" "$(cat "$status_file")" "expected completed job status"
  done

  for summary_file in "${summary_files[@]}"; do
    assert_file_contains "$summary_file" "status=completed"
    assert_file_contains "$summary_file" "trigger=periodic"
    assert_file_contains "$summary_file" "exit_code=0"
  done

  for spec_file in "${job_specs[@]}"; do
    assert_file_contains "$spec_file" '"trigger": {'
    assert_file_contains "$spec_file" '"type": "periodic"'
    assert_file_contains "$spec_file" '"timeout_seconds": 120'
  done

  echo "PASS: success case writes expected spawn flags and job artifacts"
}

run_failure_case() {
  local repo_root="$1"
  local case_dir="$2"

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_EXIT="17" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="90" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"; then
    fail "controller succeeded unexpectedly in failure case"
  fi

  shopt -s nullglob
  status_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/status)
  summary_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/summary)
  shopt -u nullglob

  assert_eq "1" "${#status_files[@]}" "expected one status file"
  assert_eq "1" "${#summary_files[@]}" "expected one summary file"

  assert_eq "failed" "$(cat "${status_files[0]}")" "expected failed job status"
  assert_file_contains "${summary_files[0]}" "status=failed"
  assert_file_contains "${summary_files[0]}" "exit_code=17"

  echo "PASS: failure case records failed sentinel with exit code"
}

run_mentions_case() {
  local repo_root="$1"
  local case_dir="$2"
  local run_log=""
  local mention_summary_count=""
  local done_count=""
  local ack_log=""
  local expected_ack_key="thread-123:2026-02-20T03:44:00Z"
  local expected_state_file="${case_dir}/workspace/watch-state/worker.json"
  local -a done_files=()

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="0" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    MOCK_HIVEMOOT_WATCH_OUTPUT='{"threadId":"thread-123","number":42,"title":"Controller mention","author":"hivemoot","body":"@hivemoot-guard please take a look","url":"https://github.com/hivemoot/hivemoot-agent/issues/130#issuecomment-1","timestamp":"2026-02-20T03:44:00Z"}' \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in mention case"
  assert_file_contains "$run_log" "-e AGENT_SESSION_KEY=mention-thread:thread-123"

  mention_summary_count="$(grep -R --include=summary -F 'trigger=mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
  assert_eq "1" "$mention_summary_count" "expected one mention-triggered job summary"

  shopt -s nullglob
  done_files=("${case_dir}/workspace"/queue/*.done)
  shopt -u nullglob
  done_count="${#done_files[@]}"
  assert_eq "1" "$done_count" "expected one processed mention trigger file"

  ack_log="${case_dir}/hivemoot-state/ack.log"
  [ -f "$ack_log" ] || fail "missing ack log in mention case"
  assert_file_contains "$ack_log" "${expected_ack_key}|${expected_state_file}"

  echo "PASS: mention case queues trigger, forwards session key, and defers ack"
}

run_mentions_dedup_case() {
  local repo_root="$1"
  local case_dir="$2"
  local run_log=""
  local controller_log=""
  local mention_summary_count=""
  local done_count=""
  local ack_log=""
  local ack_count=""
  local watch_output=""
  local expected_ack_key="thread-dup:2026-02-20T04:01:00Z"
  local expected_state_file="${case_dir}/workspace/watch-state/worker.json"
  local -a done_files=()

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  watch_output=$'{"threadId":"thread-dup","number":77,"title":"Duplicate mention","author":"hivemoot","body":"@hivemoot-guard ping","url":"https://github.com/hivemoot/hivemoot-agent/pull/132#issuecomment-1","timestamp":"2026-02-20T04:01:00Z"}\n{"threadId":"thread-dup","number":77,"title":"Duplicate mention","author":"hivemoot","body":"@hivemoot-guard ping","url":"https://github.com/hivemoot/hivemoot-agent/pull/132#issuecomment-1","timestamp":"2026-02-20T04:01:00Z"}'
  controller_log="${case_dir}/controller.log"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="0" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    MOCK_HIVEMOOT_WATCH_OUTPUT="${watch_output}" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in mention dedup case"
  assert_file_contains "$run_log" "-e AGENT_SESSION_KEY=mention-thread:thread-dup"

  mention_summary_count="$(grep -R --include=summary -F 'trigger=mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
  assert_eq "1" "$mention_summary_count" "expected one mention-triggered job summary after duplicate suppression"

  shopt -s nullglob
  done_files=("${case_dir}/workspace"/queue/*.done)
  shopt -u nullglob
  done_count="${#done_files[@]}"
  assert_eq "1" "$done_count" "expected one processed mention trigger file after duplicate suppression"

  ack_log="${case_dir}/hivemoot-state/ack.log"
  [ -f "$ack_log" ] || fail "missing ack log in mention dedup case"
  ack_count="$(wc -l < "$ack_log" | tr -d '[:space:]')"
  assert_eq "1" "$ack_count" "expected one ack call after duplicate suppression"
  assert_file_contains "$ack_log" "${expected_ack_key}|${expected_state_file}"
  assert_file_contains "$controller_log" "duplicate mention suppressed (ack_key=${expected_ack_key})"

  echo "PASS: duplicate mention events are suppressed by ack_key"
}

run_orphan_recovery_case() {
  local repo_root="$1"
  local case_dir="$2"
  local queue_file=""
  local run_log=""
  local controller_log=""
  local mention_summary_count=""
  local ack_log=""
  local expected_ack_key="thread-orphan:2026-02-20T04:11:00Z"
  local expected_state_file="${case_dir}/workspace/watch-state/worker.json"
  local -a processing_files=()
  local -a trigger_files=()
  local -a done_files=()

  mkdir -p "${case_dir}/workspace/queue"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  queue_file="${case_dir}/workspace/queue/orphan.processing"
  cat > "$queue_file" <<EOF_TRIGGER
{
  "trigger_type": "mention",
  "repo": "owner/repo",
  "agent_id": "worker",
  "extra_prompt": "Recovered orphan trigger",
  "ack_key": "${expected_ack_key}",
  "state_file": "${expected_state_file}",
  "session_key": "mention-thread:thread-orphan"
}
EOF_TRIGGER
  sleep 2
  controller_log="${case_dir}/controller.log"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="0" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="1" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in orphan recovery case"
  assert_file_contains "$run_log" "-e AGENT_SESSION_KEY=mention-thread:thread-orphan"

  mention_summary_count="$(grep -R --include=summary -F 'trigger=mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
  assert_eq "1" "$mention_summary_count" "expected recovered orphan trigger to execute once"

  shopt -s nullglob
  processing_files=("${case_dir}/workspace"/queue/*.processing)
  trigger_files=("${case_dir}/workspace"/queue/*.trigger.json)
  done_files=("${case_dir}/workspace"/queue/*.done)
  shopt -u nullglob
  assert_eq "0" "${#processing_files[@]}" "expected no stale processing files after recovery"
  assert_eq "0" "${#trigger_files[@]}" "expected no pending trigger files after recovery"
  assert_eq "1" "${#done_files[@]}" "expected recovered trigger to complete"

  ack_log="${case_dir}/hivemoot-state/ack.log"
  [ -f "$ack_log" ] || fail "missing ack log in orphan recovery case"
  assert_file_contains "$ack_log" "${expected_ack_key}|${expected_state_file}"
  assert_file_contains "$controller_log" "Recovered orphaned trigger: orphan.processing"

  echo "PASS: stale processing triggers are recovered and executed"
}

run_mentions_retry_after_failure_case() {
  local repo_root="$1"
  local case_dir="$2"
  local run1_log=""
  local run2_log=""
  local watch_output=""
  local mention_failed_count=0
  local mention_completed_count=0
  local ack_log=""
  local ack_count=""
  local expected_ack_key="thread-retry:2026-02-20T04:21:00Z"
  local expected_state_file="${case_dir}/workspace/watch-state/worker.json"
  local summary_file=""
  local -a summary_files=()

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  watch_output='{"threadId":"thread-retry","number":88,"title":"Retry mention","author":"hivemoot","body":"@hivemoot-guard retry this","url":"https://github.com/hivemoot/hivemoot-agent/pull/132#issuecomment-2","timestamp":"2026-02-20T04:21:00Z"}'
  run1_log="${case_dir}/controller-run1.log"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="0" \
    MOCK_DOCKER_WAIT_EXIT="17" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    MOCK_HIVEMOOT_WATCH_OUTPUT="${watch_output}" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$run1_log" 2>&1; then
    fail "first controller run unexpectedly succeeded in mention retry case"
  fi

  run2_log="${case_dir}/controller-run2.log"
  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="0" \
    MOCK_DOCKER_WAIT_EXIT="0" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    MOCK_HIVEMOOT_WATCH_OUTPUT="${watch_output}" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$run2_log" 2>&1

  assert_file_contains "$run2_log" "worker: queued mention trigger for #88"
  assert_file_not_contains "$run2_log" "duplicate mention suppressed (ack_key=${expected_ack_key})"

  shopt -s nullglob
  summary_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/summary)
  shopt -u nullglob

  for summary_file in "${summary_files[@]}"; do
    if ! grep -Fq 'trigger=mention' "$summary_file"; then
      continue
    fi
    if grep -Fq 'status=failed' "$summary_file"; then
      mention_failed_count=$((mention_failed_count + 1))
    fi
    if grep -Fq 'status=completed' "$summary_file"; then
      mention_completed_count=$((mention_completed_count + 1))
    fi
  done

  assert_eq "1" "$mention_failed_count" "expected one failed mention run before retry"
  assert_eq "1" "$mention_completed_count" "expected one completed mention retry run"

  ack_log="${case_dir}/hivemoot-state/ack.log"
  [ -f "$ack_log" ] || fail "missing ack log in mention retry case"
  ack_count="$(wc -l < "$ack_log" | tr -d '[:space:]')"
  assert_eq "1" "$ack_count" "expected exactly one ack after retry success"
  assert_file_contains "$ack_log" "${expected_ack_key}|${expected_state_file}"

  echo "PASS: failed mention jobs are retried on re-emitted events"
}

run_shutdown_signal_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_pid=0
  local controller_status=0
  local run_log=""
  local launch_count=""
  local deadline=0

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  run_log="${case_dir}/mock-state/docker-run.log"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="2" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="2" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_ID_02="builder" \
    AGENT_GITHUB_TOKEN_02="token-2" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"${case_dir}/controller.log" 2>&1 &
  controller_pid=$!

  deadline=$((SECONDS + 15))
  while true; do
    if [ -f "$run_log" ] && [ "$(wc -l < "$run_log" | tr -d '[:space:]')" -ge 1 ]; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      sed 's/^/  /' "${case_dir}/controller.log" >&2 || true
      fail "controller exited before first launch in shutdown test"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      sed 's/^/  /' "${case_dir}/controller.log" >&2 || true
      fail "timed out waiting for first worker launch in shutdown test"
    fi
    sleep 0.1
  done

  kill -TERM "$controller_pid"

  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  [ -f "$run_log" ] || fail "missing docker run log in shutdown test"
  launch_count="$(wc -l < "$run_log" | tr -d '[:space:]')"
  assert_eq "1" "$launch_count" "shutdown should prevent second queued launch"

  echo "PASS: shutdown blocks queued launches after signal (controller_exit=${controller_status})"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d "${repo_root}/.tmp-controller-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running controller script checks"
run_success_case "$repo_root" "${tmpdir}/success"
run_failure_case "$repo_root" "${tmpdir}/failure"
run_mentions_case "$repo_root" "${tmpdir}/mentions"
run_mentions_dedup_case "$repo_root" "${tmpdir}/mentions-dedup"
run_orphan_recovery_case "$repo_root" "${tmpdir}/orphan-recovery"
run_mentions_retry_after_failure_case "$repo_root" "${tmpdir}/mentions-retry"
run_shutdown_signal_case "$repo_root" "${tmpdir}/shutdown"
echo "PASS: controller script checks"
