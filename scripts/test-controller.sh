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

assert_exists() {
  local path="$1"

  if [ ! -e "$path" ]; then
    fail "expected path to exist: ${path}"
  fi
}

assert_not_exists() {
  local path="$1"

  if [ -e "$path" ]; then
    fail "expected path to be removed: ${path}"
  fi
}

assert_no_codex_auth_residue() {
  local homes_root="$1"
  local -a auth_files=()

  shopt -s nullglob
  auth_files=("${homes_root}"/*/.codex/auth.json)
  shopt -u nullglob

  if [ "${#auth_files[@]}" -ne 0 ]; then
    echo "Unexpected Codex auth file residue:" >&2
    printf '  %s\n' "${auth_files[@]}" >&2
    fail "leftover Codex auth file in job home"
  fi
}

assert_no_gemini_auth_residue() {
  local homes_root="$1"
  local auth_file=""
  local -a auth_files=()
  local -a gemini_auth_files=(
    "oauth_creds.json"
    "google_accounts.json"
    "settings.json"
    "mcp-oauth-tokens.json"
    "mcp-oauth-tokens-v2.json"
    ".env"
  )

  shopt -s nullglob
  for auth_file in "${gemini_auth_files[@]}"; do
    auth_files+=("${homes_root}"/*/.gemini/"${auth_file}")
  done
  shopt -u nullglob

  if [ "${#auth_files[@]}" -ne 0 ]; then
    echo "Unexpected Gemini auth file residue:" >&2
    printf '  %s\n' "${auth_files[@]}" >&2
    fail "leftover Gemini auth file in job home"
  fi
}

seed_gemini_auth_dir() {
  local gemini_auth_dir="$1"

  mkdir -p "$gemini_auth_dir"
  printf '{"refresh_token":"gemini-test-token"}\n' > "${gemini_auth_dir}/oauth_creds.json"
  printf '[{"email":"gemini@example.com"}]\n' > "${gemini_auth_dir}/google_accounts.json"
  printf '{"selectedType":"oauth-personal"}\n' > "${gemini_auth_dir}/settings.json"
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
log_lock_dir="${state_dir}/log.lock"

append_line_locked() {
  local target_file="$1"
  local text="$2"

  while ! mkdir "$log_lock_dir" 2>/dev/null; do
    sleep 0.01
  done

  printf '%s\n' "$text" >> "$target_file"
  rmdir "$log_lock_dir"
}

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

snapshot_job_home() {
  local arg=""
  local mount_spec=""
  local job_home=""
  local snapshot_file="${state_dir}/job-home-snapshots.log"

  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      -v)
        mount_spec="${2:-}"
        if [[ "$mount_spec" == *:/home/node ]]; then
          job_home="${mount_spec%:/home/node}"
        fi
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  if [ -z "$job_home" ]; then
    append_line_locked "$snapshot_file" "job_home=missing gemini_settings=missing"
    return 0
  fi

  if [ -f "${job_home}/.gemini/settings.json" ]; then
    append_line_locked \
      "$snapshot_file" \
      "job_home=${job_home} gemini_settings=$(tr -d '\n' < "${job_home}/.gemini/settings.json")"
    return 0
  fi

  append_line_locked "$snapshot_file" "job_home=${job_home} gemini_settings=missing"
}

case "$cmd" in
  run)
    # mkdir is atomic and keeps overlap detection deterministic under concurrency.
    if ! mkdir "$active_lock_dir" 2>/dev/null; then
      append_line_locked "$overlap_file" "overlap"
    fi

    snapshot_job_home "$@"
    append_line_locked "$run_log_file" "$*"

    if [ "${MOCK_DOCKER_RUN_FAIL:-0}" = "1" ]; then
      rmdir "$active_lock_dir" 2>/dev/null || true
      exit "${MOCK_DOCKER_RUN_EXIT:-1}"
    fi

    container_id="$(next_id)"
    rm -f "$(container_exited_file "$container_id")"
    printf '%s\n' "$container_id" > "$active_file"
    printf '%s\n' "$container_id"
    ;;

  logs)
    container_id="${*: -1}"
    exited_file="$(container_exited_file "$container_id")"
    if [ -n "${MOCK_DOCKER_LOG_CONTENT:-}" ]; then
      printf '%s\n' "$MOCK_DOCKER_LOG_CONTENT"
    else
      echo "mock log stream"
    fi
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

  inspect)
    if [ "${1:-}" = "--format" ]; then
      shift 2
    fi
    printf '%s %s\n' \
      "${MOCK_DOCKER_INSPECT_OOMKILLED:-false}" \
      "${MOCK_DOCKER_INSPECT_EXIT:-${MOCK_DOCKER_WAIT_EXIT:-0}}"
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

setup_mock_uname_linux() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/uname" <<'EOF_MOCK'
#!/usr/bin/env bash
printf '%s\n' "Linux"
EOF_MOCK

  chmod +x "${mock_bin}/uname"
}

setup_mock_chown_logger() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/chown" <<'EOF_MOCK'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${MOCK_CHOWN_STATE_DIR:?MOCK_CHOWN_STATE_DIR is required}"
mkdir -p "$state_dir"

printf '%s\n' "$*" >> "${state_dir}/chown.log"
EOF_MOCK

  chmod +x "${mock_bin}/chown"
}

setup_mock_rm_failer() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/rm" <<'EOF_MOCK'
#!/usr/bin/env bash
set -euo pipefail

target=""
if [ "$#" -gt 0 ]; then
  target="${@: -1}"
fi

if [ -n "${MOCK_RM_FAIL_PATH:-}" ] && [ "$target" = "${MOCK_RM_FAIL_PATH}" ]; then
  echo "mock rm failure: ${target}" >&2
  exit 1
fi

exec /bin/rm "$@"
EOF_MOCK

  chmod +x "${mock_bin}/rm"
}

create_workspace_job_layout() {
  local workspace_root="$1"
  local job_id="$2"

  mkdir -p "${workspace_root}/workspaces/${job_id}/.hivemoot"
  mkdir -p "${workspace_root}/homes/${job_id}"
  mkdir -p "${workspace_root}/runs/${job_id}"
  mkdir -p "${workspace_root}/jobs/${job_id}"

  printf '%s\n' "workspace-${job_id}" > "${workspace_root}/workspaces/${job_id}/payload.txt"
  printf '%s\n' "home-${job_id}" > "${workspace_root}/homes/${job_id}/payload.txt"
  printf '%s\n' "run-${job_id}" > "${workspace_root}/runs/${job_id}/payload.txt"
  printf '%s\n' "job-${job_id}" > "${workspace_root}/jobs/${job_id}/payload.txt"
}

run_success_case() {
  local repo_root="$1"
  local case_dir="$2"
  local codex_auth_source="${case_dir}/secrets/codex-auth.json"
  local gemini_auth_dir="${case_dir}/secrets/gemini-auth"
  local settings_snapshot=""
  local settings_count=""

  mkdir -p "$case_dir"
  mkdir -p "${case_dir}/secrets"
  printf '{"access_token":"test-token"}\n' > "$codex_auth_source"
  seed_gemini_auth_dir "$gemini_auth_dir"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_ID_02="builder" \
    AGENT_GITHUB_TOKEN_02="token-2" \
    AGENT_TIMEOUT_SECONDS="120" \
    CODEX_AUTH_FILE="${codex_auth_source}" \
    GEMINI_AUTH_DIR="${gemini_auth_dir}" \
    GIT_CLONE_DEPTH="1" \
    HIVEMOOT_BUZZ_ROLE="reviewer" \
    SHARED_CLONE_CACHE="0" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"

  # Different agents on the same repo use separate per-agent locks and are
  # allowed to run concurrently. Overlap between distinct agents is expected.

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log"
  settings_snapshot="${case_dir}/mock-state/job-home-snapshots.log"
  [ -f "$settings_snapshot" ] || fail "missing job home snapshot log"

  assert_file_contains "$run_log" "--cap-drop=ALL"
  assert_file_contains "$run_log" "--security-opt=no-new-privileges"
  assert_file_contains "$run_log" "--read-only"
  assert_file_contains "$run_log" "--tmpfs /tmp:size=2g,mode=1777"
  assert_file_contains "$run_log" "-e AGENT_PLUGINS=hivemoot-identity,github,hivemoot-github"
  assert_file_contains "$run_log" "-e AGENT_DRIVER=once"
  assert_file_contains "$run_log" "-e TARGET_REPO=owner/repo"
  assert_file_contains "$run_log" "-e GITHUB_REPOS=owner/repo"
  assert_file_contains "$run_log" "-e HIVEMOOT_BUZZ_ROLE=reviewer"
  assert_file_not_contains "$run_log" "-e AGENT_WORKLOAD=hivemoot"
  assert_file_contains "$run_log" "-e JOB_ID="
  assert_file_contains "$run_log" "-e HIVEMOOT_CLI_UPDATE=skip"
  assert_file_contains "$run_log" "-e GIT_CLONE_DEPTH=1"
  assert_file_contains "$run_log" "-e SHARED_CLONE_CACHE=0"
  assert_file_contains "$run_log" "-e AGENT_MEMORY_DIR=/home/node/.hivemoot/memory"
  assert_file_contains "$run_log" "/home/node/.hivemoot/memory"
  assert_file_not_contains "$settings_snapshot" "gemini_settings=missing"
  assert_file_contains "$settings_snapshot" 'gemini_settings={"selectedType":"oauth-personal"}'
  settings_count="$(grep -Fc 'gemini_settings={"selectedType":"oauth-personal"}' "$settings_snapshot" | tr -d '[:space:]')"
  assert_eq "2" "$settings_count" "expected Gemini settings.json in each job home before launch"

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
  assert_no_codex_auth_residue "${case_dir}/workspace/homes"
  assert_no_gemini_auth_residue "${case_dir}/workspace/homes"

  echo "PASS: success case writes expected spawn flags and job artifacts"
}

run_per_agent_skill_routing_case() {
  local repo_root="$1"
  local case_dir="$2"
  local custom_skill_dir="${case_dir}/custom-skills/skill-one"
  local custom_mount=""
  local run_log=""
  local worker_line=""
  local builder_line=""

  mkdir -p "$custom_skill_dir"
  cat > "${custom_skill_dir}/SKILL.md" <<'EOF_SKILL'
---
name: skill-one
description: Test custom skill
---
## Skill: Test Custom Skill
EOF_SKILL

  custom_mount="${custom_skill_dir}:/opt/hivemoot-agent/skills/skill-one:ro"

  setup_mock_docker "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_SKILLS_01="skill-one,release-readiness" \
    AGENT_ID_02="builder" \
    AGENT_GITHUB_TOKEN_02="token-2" \
    AGENT_SKILLS_02="proposal-architect" \
    AGENT_SKILL_BIND_MOUNTS="${custom_mount}" \
    AGENT_TIMEOUT_SECONDS="120" \
    bash "${repo_root}/scripts/controller.sh"

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in per-agent skill routing case"

  worker_line="$(grep -F "AGENT_ID=worker" "$run_log" | head -n 1 || true)"
  builder_line="$(grep -F "AGENT_ID=builder" "$run_log" | head -n 1 || true)"
  [ -n "$worker_line" ] || fail "missing worker launch in per-agent skill routing case"
  [ -n "$builder_line" ] || fail "missing builder launch in per-agent skill routing case"

  if [[ "$worker_line" != *"AGENT_SKILLS=skill-one,release-readiness"* ]]; then
    fail "worker launch did not receive worker-specific skills"
  fi

  if [[ "$builder_line" != *"AGENT_SKILLS=proposal-architect"* ]]; then
    fail "builder launch did not receive builder-specific skills"
  fi

  if [[ "$worker_line" != *"${custom_mount}"* ]]; then
    fail "custom skill bind mount missing from worker launch"
  fi

  if [[ "$builder_line" != *"${custom_mount}"* ]]; then
    fail "custom skill bind mount missing from builder launch"
  fi

  echo "PASS: controller routes per-agent skills and custom skill bind mounts"
}

run_invalid_skill_bind_mount_case() {
  local repo_root="$1"
  local case_dir="$2"
  local mount_spec="$3"
  local expected_error="$4"
  local controller_log="${case_dir}/controller.log"
  local run_log="${case_dir}/mock-state/docker-run.log"

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_SKILL_BIND_MOUNTS="${mount_spec}" \
    AGENT_TIMEOUT_SECONDS="120" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1; then
    fail "controller succeeded unexpectedly for invalid skill bind mount: ${mount_spec}"
  fi

  assert_file_contains "$controller_log" "$expected_error"
  if [ -f "$run_log" ] && [ -s "$run_log" ]; then
    fail "controller should reject invalid skill bind mounts before docker run"
  fi

  echo "PASS: invalid skill bind mount rejected (${mount_spec})"
}

run_custom_prompt_companion_base_case() {
  local repo_root="$1"
  local case_dir="$2"
  local prompt_dir="${case_dir}/custom-prompts"
  local prompt_file="${prompt_dir}/task.md"
  local base_file="${prompt_dir}/base.md"
  local run_log=""

  mkdir -p "$prompt_dir"
  printf 'custom base prompt\n' > "$base_file"
  printf 'custom task prompt\n' > "$prompt_file"
  setup_mock_docker "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_PROMPT_FILE="${prompt_file}" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in custom prompt case"
  assert_file_contains "$run_log" "-e AGENT_PROMPT_FILE=${prompt_file}"
  assert_file_contains "$run_log" "-v ${prompt_file}:${prompt_file}:ro"
  assert_file_contains "$run_log" "-v ${base_file}:${base_file}:ro"

  echo "PASS: custom prompt case mounts sibling base prompt"
}

run_failure_case() {
  local repo_root="$1"
  local case_dir="$2"
  local codex_auth_source="${case_dir}/secrets/codex-auth.json"
  local gemini_auth_dir="${case_dir}/secrets/gemini-auth"

  mkdir -p "$case_dir"
  mkdir -p "${case_dir}/secrets"
  printf '{"access_token":"test-token"}\n' > "$codex_auth_source"
  seed_gemini_auth_dir "$gemini_auth_dir"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="90" \
    CODEX_AUTH_FILE="${codex_auth_source}" \
    GEMINI_AUTH_DIR="${gemini_auth_dir}" \
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
  assert_no_codex_auth_residue "${case_dir}/workspace/homes"
  assert_no_gemini_auth_residue "${case_dir}/workspace/homes"

  echo "PASS: failure case records failed sentinel with exit code"
}

run_spawn_failure_cleanup_case() {
  local repo_root="$1"
  local case_dir="$2"
  local codex_auth_source="${case_dir}/secrets/codex-auth.json"
  local gemini_auth_dir="${case_dir}/secrets/gemini-auth"

  mkdir -p "$case_dir"
  mkdir -p "${case_dir}/secrets"
  printf '{"access_token":"test-token"}\n' > "$codex_auth_source"
  seed_gemini_auth_dir "$gemini_auth_dir"
  setup_mock_docker "${case_dir}/mock-bin"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_RUN_FAIL="1" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="90" \
    CODEX_AUTH_FILE="${codex_auth_source}" \
    GEMINI_AUTH_DIR="${gemini_auth_dir}" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh"; then
    fail "controller succeeded unexpectedly in spawn failure case"
  fi

  assert_no_codex_auth_residue "${case_dir}/workspace/homes"
  assert_no_gemini_auth_residue "${case_dir}/workspace/homes"

  echo "PASS: spawn failure cleanup removes copied provider auth files"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
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

  mention_summary_count="$(grep -R --include=summary -F 'trigger=github-mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
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

  mention_summary_count="$(grep -R --include=summary -F 'trigger=github-mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
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

  mention_summary_count="$(grep -R --include=summary -F 'trigger=github-mention' "${case_dir}/workspace/workspaces" | wc -l | tr -d '[:space:]')"
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
  local run3_log=""
  local watch_output=""
  local retry_backoff_secs="300"
  local mention_failed_count=0
  local mention_completed_count=0
  local ack_log=""
  local ack_count=""
  local expected_ack_key="thread-retry:2026-02-20T04:21:00Z"
  local expected_state_file="${case_dir}/workspace/watch-state/worker.json"
  local failed_file=""
  local summary_file=""
  local -a failed_files=()
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    WATCH_TRIGGER_FAILURE_BACKOFF_SECS="${retry_backoff_secs}" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$run1_log" 2>&1; then
    fail "first controller run unexpectedly succeeded in mention retry case"
  fi

  shopt -s nullglob
  failed_files=("${case_dir}/workspace"/queue/*.failed)
  shopt -u nullglob
  assert_eq "1" "${#failed_files[@]}" "expected one failed queue artifact after initial failure"
  failed_file="${failed_files[0]}"

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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    WATCH_TRIGGER_FAILURE_BACKOFF_SECS="${retry_backoff_secs}" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$run2_log" 2>&1

  assert_file_contains "$run2_log" "duplicate mention suppressed (ack_key=${expected_ack_key})"
  assert_file_not_contains "$run2_log" "worker: queued mention trigger for #88"

  touch -t 202001010000 "$failed_file"

  run3_log="${case_dir}/controller-run3.log"
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
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    WATCH_TRIGGER_FAILURE_BACKOFF_SECS="${retry_backoff_secs}" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$run3_log" 2>&1

  assert_file_contains "$run3_log" "worker: queued mention trigger for #88"
  assert_file_not_contains "$run3_log" "duplicate mention suppressed (ack_key=${expected_ack_key})"

  shopt -s nullglob
  summary_files=("${case_dir}/workspace"/workspaces/*/.hivemoot/summary)
  shopt -u nullglob

  for summary_file in "${summary_files[@]}"; do
    if ! grep -Fq 'trigger=github-mention' "$summary_file"; then
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

  echo "PASS: failed mention jobs back off before retrying re-emitted events"
}

# Regression: a controller-side AGENT_WORKLOAD (set for other triggers or
# leaked from the environment) must not route claimed task jobs to the
# shell workload branch of spawn_worker().

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

  # MAX_WORKERS=1 forces the second job to queue behind the first. SIGTERM
  # arrives while the first is running; wait_for_available_slot detects shutdown
  # and cancels the second launch. With per-agent locks, different agents can
  # otherwise run concurrently, so worker-slot contention is the only reliable
  # way to hold a second job in the queue for this test.
  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="2" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
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

run_shutdown_terminates_subshells_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_pid=0
  local controller_status=0
  local run_log=""
  local deadline=0
  local -a subshell_pids=()
  local subshell_pid=""
  local orphan_count=0

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  run_log="${case_dir}/mock-state/docker-run.log"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="60" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
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
      fail "controller exited before first launch in shutdown-terminates-subshells test"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      sed 's/^/  /' "${case_dir}/controller.log" >&2 || true
      fail "timed out waiting for first worker launch in shutdown-terminates-subshells test"
    fi
    sleep 0.1
  done

  local candidate_pid=""
  local candidate_comm=""
  while IFS= read -r candidate_pid; do
    [ -n "$candidate_pid" ] || continue
    candidate_comm="$(ps -p "$candidate_pid" -o comm= 2>/dev/null || true)"
    [ "$candidate_comm" = "bash" ] && subshell_pids+=("$candidate_pid")
  done < <(pgrep -P "$controller_pid" 2>/dev/null || true)

  [ "${#subshell_pids[@]}" -gt 0 ] || fail "no bash job subshell PIDs found in shutdown-terminates-subshells test"

  kill -TERM "$controller_pid"

  deadline=$((SECONDS + 20))
  while kill -0 "$controller_pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -KILL "$controller_pid" 2>/dev/null || true
      for subshell_pid in "${subshell_pids[@]}"; do
        kill -KILL "$subshell_pid" 2>/dev/null || true
      done
      fail "controller did not exit within 20s after SIGTERM in shutdown-terminates-subshells test"
    fi
    sleep 0.1
  done

  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  orphan_count=0
  for subshell_pid in "${subshell_pids[@]}"; do
    if kill -0 "$subshell_pid" 2>/dev/null; then
      orphan_count=$((orphan_count + 1))
      echo "  orphan PID still alive: ${subshell_pid}" >&2
      kill -KILL "$subshell_pid" 2>/dev/null || true
    fi
  done

  assert_eq "0" "$orphan_count" "job subshells must be terminated by handle_shutdown"

  echo "PASS: SIGTERM terminates tracked job subshells in bounded time (controller_exit=${controller_status})"
}

run_exit_trap_reaps_job_subshells_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_pid=0
  local controller_status=0
  local run_log=""
  local deadline=0
  local -a subshell_pids=()
  local subshell_pid=""
  local orphan_count=0

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  run_log="${case_dir}/mock-state/docker-run.log"

  # Long docker wait ensures the job subshell is still alive when we
  # trigger EXIT.  MOCK_DOCKER_WAIT_SLEEP_SECS=3 gives a clear window
  # to send SIGHUP while the subshell is blocked in `docker wait`.
  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="3" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"${case_dir}/controller.log" 2>&1 &
  controller_pid=$!

  # Wait for the first docker run to be issued, confirming the job
  # subshell is alive and tracked in running_pids.
  deadline=$((SECONDS + 15))
  while true; do
    if [ -f "$run_log" ] && [ "$(wc -l < "$run_log" | tr -d '[:space:]')" -ge 1 ]; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      sed 's/^/  /' "${case_dir}/controller.log" >&2 || true
      fail "controller exited before first launch in exit-trap reap case"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      sed 's/^/  /' "${case_dir}/controller.log" >&2 || true
      fail "timed out waiting for first worker launch in exit-trap reap case"
    fi
    sleep 0.1
  done

  # Capture direct bash child PIDs before triggering exit.  Job subshells
  # spawned via `( run_job ... ) &` are bash processes.  Transient children
  # like `sleep` or `docker` are excluded to avoid false-positive orphan
  # checks for processes not tracked in running_pids.
  local candidate_pid=""
  local candidate_comm=""
  while IFS= read -r candidate_pid; do
    [ -n "$candidate_pid" ] || continue
    candidate_comm="$(ps -p "$candidate_pid" -o comm= 2>/dev/null || true)"
    [ "$candidate_comm" = "bash" ] && subshell_pids+=("$candidate_pid")
  done < <(pgrep -P "$controller_pid" 2>/dev/null || true)

  [ "${#subshell_pids[@]}" -gt 0 ] || fail "no bash job subshell PIDs found after first launch"

  # Send SIGHUP — bash runs EXIT traps for untrapped SIGHUP, exercising
  # cleanup() directly without going through handle_shutdown().
  kill -HUP "$controller_pid"

  # Controller must exit within a generous timeout.
  deadline=$((SECONDS + 15))
  while kill -0 "$controller_pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -KILL "$controller_pid" 2>/dev/null || true
      fail "controller did not exit after SIGHUP in exit-trap reap case"
    fi
    sleep 0.1
  done

  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  # All tracked job subshell PIDs must be reaped — none should still be alive.
  orphan_count=0
  for subshell_pid in "${subshell_pids[@]}"; do
    if kill -0 "$subshell_pid" 2>/dev/null; then
      orphan_count=$((orphan_count + 1))
      echo "  orphan PID still alive: ${subshell_pid}" >&2
      kill -KILL "$subshell_pid" 2>/dev/null || true
    fi
  done

  assert_eq "0" "$orphan_count" "tracked job subshell(s) must be reaped by EXIT trap cleanup"

  echo "PASS: EXIT trap cleanup reaps tracked job subshells (controller_exit=${controller_status})"
}

run_global_slots_cross_controller_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_a_pid=""
  local controller_b_pid=""
  local controller_a_status=0
  local controller_b_status=0
  local controller_a_log="${case_dir}/controller-a.log"
  local controller_b_log="${case_dir}/controller-b.log"
  local run_log="${case_dir}/mock-state/docker-run.log"
  local overlap_file="${case_dir}/mock-state/overlap.log"
  local launch_count=""
  local deadline=0

  mkdir -p "${case_dir}/global-slots"
  setup_mock_docker "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home-a" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="2" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    GLOBAL_SLOTS_DIR="${case_dir}/global-slots" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace-a" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_a_log" 2>&1 &
  controller_a_pid=$!

  deadline=$((SECONDS + 15))
  while true; do
    if [ -f "$run_log" ] && [ "$(wc -l < "$run_log" | tr -d '[:space:]')" -ge 1 ]; then
      break
    fi
    if ! kill -0 "$controller_a_pid" 2>/dev/null; then
      sed 's/^/  /' "$controller_a_log" >&2 || true
      fail "controller A exited before first worker launch in global-slots case"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      sed 's/^/  /' "$controller_a_log" >&2 || true
      fail "timed out waiting for controller A to launch its worker"
    fi
    sleep 0.1
  done

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home-b" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="2" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    GLOBAL_SLOTS_DIR="${case_dir}/global-slots" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace-b" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="builder" \
    AGENT_GITHUB_TOKEN_01="token-2" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_b_log" 2>&1 &
  controller_b_pid=$!

  if wait "$controller_a_pid"; then
    controller_a_status=0
  else
    controller_a_status=$?
  fi
  if wait "$controller_b_pid"; then
    controller_b_status=0
  else
    controller_b_status=$?
  fi

  if [ "$controller_a_status" -ne 0 ]; then
    sed 's/^/  /' "$controller_a_log" >&2 || true
    fail "controller A failed in global-slots case"
  fi
  if [ "$controller_b_status" -ne 0 ]; then
    sed 's/^/  /' "$controller_b_log" >&2 || true
    fail "controller B failed in global-slots case"
  fi

  [ -f "$run_log" ] || fail "missing docker run log in global-slots case"
  launch_count="$(wc -l < "$run_log" | tr -d '[:space:]')"
  assert_eq "2" "$launch_count" "expected each controller to launch exactly one worker"
  if [ -f "$overlap_file" ] && [ -s "$overlap_file" ]; then
    sed 's/^/  /' "$overlap_file" >&2 || true
    fail "global slot semaphore should prevent overlapping worker launches across controllers"
  fi

  assert_file_contains "$controller_a_log" "Global worker slots enabled: count=1"
  assert_file_contains "$controller_b_log" "Global worker slots enabled: count=1"

  echo "PASS: global slot semaphore limits combined concurrency across controllers"
}

run_global_slots_missing_dir_warning_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_log="${case_dir}/controller.log"

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1

  assert_file_contains "$controller_log" "[global-slots] disabled: GLOBAL_SLOTS_DIR is required when GLOBAL_MAX_WORKERS>0"

  echo "PASS: controller warns when GLOBAL_MAX_WORKERS is set without GLOBAL_SLOTS_DIR"
}

run_mention_watcher_failure_logging_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_log="${case_dir}/controller.log"
  local controller_pid=0
  local deadline=0

  mkdir -p "$case_dir"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    MOCK_HIVEMOOT_WATCH_FAIL="1" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="loop" \
    CONTROLLER_MAX_WORKERS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1 &
  controller_pid=$!

  deadline=$((SECONDS + 15))
  while true; do
    if grep -Fq "mention watcher failed (" "$controller_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "controller exited before watcher failure was logged"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -TERM "$controller_pid" 2>/dev/null || true
      wait "$controller_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "timed out waiting for watcher failure log"
    fi
    sleep 0.1
  done

  kill -TERM "$controller_pid" 2>/dev/null || true
  wait "$controller_pid" 2>/dev/null || true

  assert_file_contains "$controller_log" "mention watcher failed ("
  assert_file_contains "$controller_log" "hivemoot_exit=1"

  echo "PASS: mention watcher logs pipeline failure details before restart"
}

run_global_slot_mention_timeout_requeue_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_log="${case_dir}/controller.log"
  local controller_pid=""
  local controller_status=0
  local holder_pid=""
  local deadline=0
  local -a requeued=()
  local -a failed=()

  mkdir -p "${case_dir}/workspace/queue" "${case_dir}/global-slots"
  : > "${case_dir}/global-slots/slot-1.lock"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  cat > "${case_dir}/workspace/queue/mention-timeout.trigger.json" <<EOF_TRIGGER
{
  "trigger_type": "mention",
  "repo": "owner/repo",
  "agent_id": "worker",
  "extra_prompt": "Global slot timeout mention",
  "ack_key": "thread-timeout:2026-03-16T00:00:00Z",
  "state_file": "${case_dir}/workspace/watch-state/worker.json",
  "session_key": "mention-thread:thread-timeout"
}
EOF_TRIGGER

  (
    exec 9>>"${case_dir}/global-slots/slot-1.lock"
    flock 9
    sleep 5
  ) &
  holder_pid=$!

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="loop" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    GLOBAL_SLOTS_DIR="${case_dir}/global-slots" \
    GLOBAL_SLOT_TIMEOUT_MENTION_SECS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1 &
  controller_pid=$!

  deadline=$((SECONDS + 20))
  while true; do
    if grep -Fq "Global slot timeout (1s); re-queued mention trigger" "$controller_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "controller exited before mention global-slot timeout was observed"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -TERM "$controller_pid" 2>/dev/null || true
      wait "$controller_pid" 2>/dev/null || true
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "timed out waiting for mention global-slot timeout"
    fi
    sleep 0.1
  done

  kill -TERM "$controller_pid" 2>/dev/null || true
  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  if [ "$controller_status" -ne 0 ] && [ "$controller_status" -ne 143 ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
    sed 's/^/  /' "$controller_log" >&2 || true
    fail "controller failed in global-slot mention timeout case"
  fi

  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true

  shopt -s nullglob
  requeued=("${case_dir}/workspace/queue/"*.trigger.json)
  failed=("${case_dir}/workspace/queue/"*.failed)
  shopt -u nullglob

  if [ "${#requeued[@]}" -ne 1 ]; then
    fail "expected timed-out mention to be re-queued exactly once (found ${#requeued[@]})"
  fi
  assert_eq "0" "${#failed[@]}" "timed-out mention must not be finalized as failed"
  assert_file_contains "$controller_log" "Global slot timeout (1s); re-queued mention trigger"

  if [ -f "${case_dir}/mock-state/docker-run.log" ] && [ -s "${case_dir}/mock-state/docker-run.log" ]; then
    fail "mention timeout case should not launch a worker when the global slot is unavailable"
  fi

  echo "PASS: mention timeout re-queues trigger when the global slot stays busy (controller_exit=${controller_status})"
}

run_global_slot_mention_timeout_missing_run_dir_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_log="${case_dir}/controller.log"
  local controller_pid=""
  local controller_status=0
  local holder_pid=""
  local run_dir_reaper_pid=""
  local run_dir_reaper_status=0
  local deadline=0
  local run_dir=""
  local -a requeued=()
  local -a failed=()

  mkdir -p "${case_dir}/workspace/queue" "${case_dir}/global-slots"
  : > "${case_dir}/global-slots/slot-1.lock"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  cat > "${case_dir}/workspace/queue/mention-timeout.trigger.json" <<EOF_TRIGGER
{
  "trigger_type": "mention",
  "repo": "owner/repo",
  "agent_id": "worker",
  "extra_prompt": "Global slot timeout mention missing run dir",
  "ack_key": "thread-timeout-missing-run-dir:2026-03-16T00:00:00Z",
  "state_file": "${case_dir}/workspace/watch-state/worker.json",
  "session_key": "mention-thread:thread-timeout-missing-run-dir"
}
EOF_TRIGGER

  (
    exec 9>>"${case_dir}/global-slots/slot-1.lock"
    flock 9
    sleep 5
  ) &
  holder_pid=$!

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="loop" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    GLOBAL_SLOTS_DIR="${case_dir}/global-slots" \
    GLOBAL_SLOT_TIMEOUT_MENTION_SECS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="30" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="60" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1 &
  controller_pid=$!

  (
    deadline=$((SECONDS + 20))
    while [ "$SECONDS" -lt "$deadline" ]; do
      run_dir="$(find "${case_dir}/workspace/runs" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null || true)"
      if [ -n "$run_dir" ]; then
        rm -rf "$run_dir"
        exit 0
      fi
      sleep 0.05
    done
    exit 1
  ) &
  run_dir_reaper_pid=$!

  deadline=$((SECONDS + 20))
  while true; do
    if grep -Fq "Global slot timeout (1s); re-queued mention trigger" "$controller_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      wait "$run_dir_reaper_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "controller exited before missing-run-dir mention timeout was observed"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -TERM "$controller_pid" 2>/dev/null || true
      wait "$controller_pid" 2>/dev/null || true
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      wait "$run_dir_reaper_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "timed out waiting for missing-run-dir mention timeout"
    fi
    sleep 0.1
  done

  if wait "$run_dir_reaper_pid"; then
    run_dir_reaper_status=0
  else
    run_dir_reaper_status=$?
  fi

  kill -TERM "$controller_pid" 2>/dev/null || true
  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  if [ "$controller_status" -ne 0 ] && [ "$controller_status" -ne 143 ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
    sed 's/^/  /' "$controller_log" >&2 || true
    fail "controller failed in missing-run-dir mention timeout case"
  fi

  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true

  assert_eq "0" "$run_dir_reaper_status" "expected test helper to remove the job run directory before timeout handling"

  shopt -s nullglob
  requeued=("${case_dir}/workspace/queue/"*.trigger.json)
  failed=("${case_dir}/workspace/queue/"*.failed)
  shopt -u nullglob

  if [ "${#requeued[@]}" -ne 1 ]; then
    fail "expected timed-out mention to be re-queued exactly once after removing the run directory (found ${#requeued[@]})"
  fi
  assert_eq "0" "${#failed[@]}" "timed-out mention must not be finalized as failed when the run directory disappears"
  assert_file_contains "$controller_log" "Global slot timeout (1s); re-queued mention trigger"

  if [ -f "${case_dir}/mock-state/docker-run.log" ] && [ -s "${case_dir}/mock-state/docker-run.log" ]; then
    fail "missing-run-dir timeout case should not launch a worker when the global slot is unavailable"
  fi

  echo "PASS: mention timeout re-queues trigger even if the job run directory is removed before timeout handling (controller_exit=${controller_status})"
}

run_global_slot_periodic_timeout_cleanup_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_pid=""
  local controller_status=0
  local controller_log="${case_dir}/controller.log"
  local holder_pid=""
  local deadline=0
  local -a processing_files=()
  local -a done_files=()

  mkdir -p "${case_dir}/workspace/queue" "${case_dir}/global-slots"
  : > "${case_dir}/global-slots/slot-1.lock"
  setup_mock_docker "${case_dir}/mock-bin"

  (
    exec 9>>"${case_dir}/global-slots/slot-1.lock"
    flock 9
    sleep 5
  ) &
  holder_pid=$!

  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="loop" \
    CONTROLLER_MAX_WORKERS="1" \
    GLOBAL_MAX_WORKERS="1" \
    GLOBAL_SLOTS_DIR="${case_dir}/global-slots" \
    GLOBAL_SLOT_TIMEOUT_PERIODIC_SECS="1" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="0" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1 &
  controller_pid=$!

  deadline=$((SECONDS + 20))
  while true; do
    if grep -Fq "Global slot timeout (1s); skipping periodic trigger" "$controller_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "controller exited before periodic global-slot timeout was observed"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -TERM "$controller_pid" 2>/dev/null || true
      wait "$controller_pid" 2>/dev/null || true
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "timed out waiting for periodic global-slot timeout"
    fi
    sleep 0.1
  done

  kill -TERM "$controller_pid" 2>/dev/null || true
  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true

  shopt -s nullglob
  processing_files=("${case_dir}/workspace"/queue/*.processing)
  done_files=("${case_dir}/workspace"/queue/*.done)
  shopt -u nullglob

  assert_eq "0" "${#processing_files[@]}" "expected no lingering .processing files after periodic global-slot timeout"
  if [ "${#done_files[@]}" -lt 1 ]; then
    fail "expected at least one finalized .done artifact after periodic global-slot timeout"
  fi

  if [ -f "${case_dir}/mock-state/docker-run.log" ] && [ -s "${case_dir}/mock-state/docker-run.log" ]; then
    fail "periodic timeout case should not launch a worker while the global slot is held"
  fi

  echo "PASS: periodic timeout finalizes queue artifacts cleanly (controller_exit=${controller_status})"
}

run_same_agent_concurrent_case() {
  local repo_root="$1"
  local case_dir="$2"
  local run_log=""
  local controller_log=""
  local launch_count=""
  local mention_trigger_file=""
  local -a requeued=()

  mkdir -p "${case_dir}/workspace/queue"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  # Pre-write a mention trigger for the same agent that will receive
  # the periodic trigger. The controller will attempt to launch it via
  # process_queue() while the periodic job's subshell is still alive.
  mention_trigger_file="${case_dir}/workspace/queue/mention-concurrent.trigger.json"
  cat > "$mention_trigger_file" <<EOF_TRIGGER
{
  "trigger_type": "mention",
  "repo": "owner/repo",
  "agent_id": "worker",
  "extra_prompt": "Concurrent mention test",
  "ack_key": "thread-concurrent:2026-02-23T00:00:00Z",
  "state_file": "${case_dir}/workspace/watch-state/worker.json",
  "session_key": "mention-thread:thread-concurrent"
}
EOF_TRIGGER

  controller_log="${case_dir}/controller.log"

  # MAX_WORKERS=2 ensures the global slot count is not the reason the
  # mention is deferred — only the per-agent guard should block it.
  # MOCK_DOCKER_WAIT_SLEEP_SECS=2 keeps the periodic subshell alive long
  # enough for process_queue() to run while it is still in running_pids.
  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="2" \
    MOCK_HIVEMOOT_STATE_DIR="${case_dir}/hivemoot-state" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="once" \
    CONTROLLER_MAX_WORKERS="2" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
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
  [ -f "$run_log" ] || fail "missing docker run log in same-agent-concurrent case"

  launch_count="$(wc -l < "$run_log" | tr -d '[:space:]')"
  assert_eq "1" "$launch_count" "per-agent guard should prevent second launch for same agent"

  assert_file_contains "$controller_log" "already running"
  assert_file_contains "$controller_log" "deferring github-mention trigger"

  # Mention trigger must be re-queued as .trigger.json, not lost or marked done.
  shopt -s nullglob
  requeued=("${case_dir}/workspace/queue/"*.trigger.json)
  shopt -u nullglob
  if [ "${#requeued[@]}" -ne 1 ]; then
    fail "expected mention trigger to be re-queued as .trigger.json (found ${#requeued[@]})"
  fi

  echo "PASS: per-agent guard defers concurrent trigger and re-queues mention"
}

run_periodic_deferral_cleanup_case() {
  local repo_root="$1"
  local case_dir="$2"
  local controller_pid=""
  local controller_status=0
  local controller_log=""
  local run_log=""
  local launch_count=""
  local done_count=0
  local deadline=0
  local -a processing_files=()
  local -a done_files=()

  mkdir -p "${case_dir}/workspace/queue"
  setup_mock_docker "${case_dir}/mock-bin"
  setup_mock_hivemoot "${case_dir}/mock-bin"

  controller_log="${case_dir}/controller.log"
  env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    MOCK_DOCKER_STATE_DIR="${case_dir}/mock-state" \
    MOCK_DOCKER_WAIT_SLEEP_SECS="3" \
    TARGET_REPO="owner/repo" \
    CONTROLLER_RUN_MODE="loop" \
    CONTROLLER_MAX_WORKERS="2" \
    CONTROLLER_WORKSPACE_ROOT="${case_dir}/workspace" \
    CONTROLLER_LOCK_DIR="${case_dir}/locks" \
    CONTROLLER_TOKEN_TMP_ROOT="${case_dir}/token-tmp" \
    WORKER_IMAGE="hivemoot-agent:test" \
    WATCH_MENTIONS="0" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    AGENT_TIMEOUT_SECONDS="120" \
    PERIODIC_INTERVAL_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    bash "${repo_root}/scripts/controller.sh" >"$controller_log" 2>&1 &
  controller_pid=$!

  deadline=$((SECONDS + 20))
  while true; do
    if grep -Fq "deferring periodic trigger" "$controller_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "controller exited before periodic deferral was observed"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      sed 's/^/  /' "$controller_log" >&2 || true
      fail "timed out waiting for periodic deferral"
    fi
    sleep 0.1
  done

  kill -TERM "$controller_pid" 2>/dev/null || true
  if wait "$controller_pid"; then
    controller_status=0
  else
    controller_status=$?
  fi

  run_log="${case_dir}/mock-state/docker-run.log"
  [ -f "$run_log" ] || fail "missing docker run log in periodic deferral cleanup case"
  launch_count="$(wc -l < "$run_log" | tr -d '[:space:]')"
  if [ "$launch_count" -lt 1 ]; then
    fail "expected at least one launched worker in periodic deferral cleanup case"
  fi

  shopt -s nullglob
  processing_files=("${case_dir}/workspace"/queue/*.processing)
  done_files=("${case_dir}/workspace"/queue/*.done)
  shopt -u nullglob

  assert_eq "0" "${#processing_files[@]}" "expected no lingering .processing files after periodic deferrals"
  done_count="${#done_files[@]}"
  if [ "$done_count" -lt 1 ]; then
    fail "expected at least one finalized queue artifact after periodic deferral"
  fi

  assert_file_contains "$controller_log" "deferring periodic trigger"
  echo "PASS: periodic deferrals finalize queue artifacts (controller_exit=${controller_status})"
}


repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d "${repo_root}/.tmp-controller-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running controller script checks"
run_success_case "$repo_root" "${tmpdir}/success"
run_per_agent_skill_routing_case "$repo_root" "${tmpdir}/per-agent-skill-routing"
run_invalid_skill_bind_mount_case \
  "$repo_root" \
  "${tmpdir}/invalid-skill-bind-mount-traversal" \
  "${tmpdir}/custom-skill:/opt/hivemoot-agent/skills/../../etc:ro" \
  "AGENT_SKILL_BIND_MOUNTS contains path traversal:"
run_invalid_skill_bind_mount_case \
  "$repo_root" \
  "${tmpdir}/invalid-skill-bind-mount-relative" \
  "relative-skill:/opt/hivemoot-agent/skills/skill-one:ro" \
  "AGENT_SKILL_BIND_MOUNTS contains invalid mount spec:"
run_invalid_skill_bind_mount_case \
  "$repo_root" \
  "${tmpdir}/invalid-skill-bind-mount-destination" \
  "${tmpdir}/custom-skill:/opt/hivemoot-agent/custom-skills/skill-one:ro" \
  "AGENT_SKILL_BIND_MOUNTS contains invalid mount spec:"
run_custom_prompt_companion_base_case "$repo_root" "${tmpdir}/custom-prompt-companion-base"
run_failure_case "$repo_root" "${tmpdir}/failure"
run_spawn_failure_cleanup_case "$repo_root" "${tmpdir}/spawn-failure"
run_mentions_case "$repo_root" "${tmpdir}/mentions"
run_mentions_dedup_case "$repo_root" "${tmpdir}/mentions-dedup"
run_orphan_recovery_case "$repo_root" "${tmpdir}/orphan-recovery"
run_mentions_retry_after_failure_case "$repo_root" "${tmpdir}/mentions-retry"
run_shutdown_signal_case "$repo_root" "${tmpdir}/shutdown"
run_shutdown_terminates_subshells_case "$repo_root" "${tmpdir}/shutdown-terminates-subshells"
run_exit_trap_reaps_job_subshells_case "$repo_root" "${tmpdir}/exit-trap-reap"
run_global_slots_cross_controller_case "$repo_root" "${tmpdir}/global-slots-cross-controller"
run_global_slots_missing_dir_warning_case "$repo_root" "${tmpdir}/global-slots-missing-dir"
run_mention_watcher_failure_logging_case "$repo_root" "${tmpdir}/mention-watcher-failure-logging"
run_global_slot_mention_timeout_requeue_case "$repo_root" "${tmpdir}/global-slot-mention-timeout"
run_global_slot_mention_timeout_missing_run_dir_case "$repo_root" "${tmpdir}/global-slot-mention-timeout-missing-run-dir"
run_global_slot_periodic_timeout_cleanup_case "$repo_root" "${tmpdir}/global-slot-periodic-timeout"
run_same_agent_concurrent_case "$repo_root" "${tmpdir}/same-agent-concurrent"
run_periodic_deferral_cleanup_case "$repo_root" "${tmpdir}/periodic-deferral-cleanup"

echo "PASS: controller script checks"
