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
run_shutdown_signal_case "$repo_root" "${tmpdir}/shutdown"
echo "PASS: controller script checks"
