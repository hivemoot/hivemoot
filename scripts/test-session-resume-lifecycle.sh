#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [ "$expected" != "$actual" ]; then
    fail "${message} (expected='${expected}' actual='${actual}')"
  fi
}

assert_gt() {
  local lhs="$1"
  local rhs="$2"
  local message="$3"
  if [ "$lhs" -le "$rhs" ]; then
    fail "${message} (lhs=${lhs} rhs=${rhs})"
  fi
}

assert_ge() {
  local lhs="$1"
  local rhs="$2"
  local message="$3"
  if [ "$lhs" -lt "$rhs" ]; then
    fail "${message} (lhs=${lhs} rhs=${rhs})"
  fi
}

build_scoped_session_key() {
  local base_key="$1"
  local repo_full_name="$2"
  local provider_name="$3"
  local model_name="$4"
  local tool_options_json="$5"
  local options_hash=""
  local resolved_model=""

  options_hash="$(printf '%s' "$tool_options_json" | cksum | awk '{print $1}')"
  resolved_model="${model_name:-default}"
  printf 'repo=%s|provider=%s|model=%s|toolopts=%s|key=%s' \
    "$repo_full_name" "$provider_name" "$resolved_model" "$options_hash" "$base_key"
}

read_session_record() {
  local map_file="$1"
  local session_key="$2"

  if [ ! -f "$map_file" ]; then
    return 0
  fi

  awk -F '\t' -v key="$session_key" '
    $1 == key {
      sid = $2
      created = $3
      last_used = $4
    }
    END {
      if (sid != "") {
        print sid "\t" created "\t" last_used
      }
    }
  ' "$map_file"
}

setup_mocks() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "api" ] && [ "${2:-}" = "user" ]; then
  echo "tester"
  exit 0
fi

if [ "${1:-}" = "api" ] && [[ "${2:-}" == repos/* ]]; then
  echo "${2#repos/}"
  exit 0
fi

if [ "${1:-}" = "api" ] && [ "${2:-}" = "installation" ]; then
  echo "1"
  exit 0
fi

if [ "${1:-}" = "auth" ] && [ "${2:-}" = "setup-git" ]; then
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
EOF

  cat > "${mock_bin}/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

contains_arg() {
  local needle="$1"
  shift
  local arg=""
  for arg in "$@"; do
    if [ "$arg" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

emit_thread_started() {
  local thread_id="$1"
  printf '{"type":"thread.started","thread_id":"%s"}\n' "$thread_id"
}

next_attempt() {
  local state_file="${CODEX_TEST_STATE_FILE:?CODEX_TEST_STATE_FILE is required}"
  local current=0
  if [ -f "$state_file" ]; then
    current="$(cat "$state_file")"
  fi
  current=$((current + 1))
  printf '%s' "$current" > "$state_file"
}

if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  exit 0
fi

if [ "${1:-}" = "exec" ] && [ "${2:-}" = "--help" ]; then
  echo "usage: codex exec [resume]"
  exit 0
fi

if [ "${1:-}" = "exec" ] && [ "${2:-}" = "resume" ] && contains_arg "--help" "$@"; then
  echo "usage: codex exec resume"
  exit 0
fi

scenario="${CODEX_TEST_SCENARIO:-}"

if [ "${1:-}" = "exec" ] && [ "${2:-}" = "resume" ]; then
  next_attempt
  case "$scenario" in
    resume_fail_then_fresh_fail)
      emit_thread_started "${CODEX_RESUME_THREAD_ID:?CODEX_RESUME_THREAD_ID is required}"
      exit 17
      ;;
    resume_success_same_id)
      emit_thread_started "${CODEX_RESUME_THREAD_ID:?CODEX_RESUME_THREAD_ID is required}"
      exit 0
      ;;
    resume_fail_fresh_success_new_id)
      emit_thread_started "${CODEX_RESUME_THREAD_ID:?CODEX_RESUME_THREAD_ID is required}"
      exit 23
      ;;
    *)
      echo "unexpected resume scenario: ${scenario}" >&2
      exit 1
      ;;
  esac
fi

if [ "${1:-}" = "exec" ]; then
  next_attempt
  case "$scenario" in
    resume_fail_then_fresh_fail)
      echo '{"type":"run.failed"}'
      exit 19
      ;;
    resume_fail_fresh_success_new_id|fresh_success_new_id)
      emit_thread_started "${CODEX_FRESH_THREAD_ID:?CODEX_FRESH_THREAD_ID is required}"
      exit 0
      ;;
    *)
      echo "unexpected fresh scenario: ${scenario}" >&2
      exit 1
      ;;
  esac
fi

echo "unexpected codex invocation: $*" >&2
exit 1
EOF

  cat > "${mock_bin}/mktemp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  /usr/bin/mktemp
  exit 0
fi

template="$1"
shift || true

if [[ "$template" == *XXXXXX* ]]; then
  prefix="${template%%XXXXXX*}"
  suffix="${template#*XXXXXX}"
  while true; do
    candidate="${prefix}${RANDOM}${RANDOM}${suffix}"
    if [ ! -e "$candidate" ]; then
      : > "$candidate"
      echo "$candidate"
      exit 0
    fi
  done
fi

/usr/bin/mktemp "$template" "$@"
EOF

  cat > "${mock_bin}/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

contains_arg() {
  local needle="$1"
  shift
  local arg=""
  for arg in "$@"; do
    if [ "$arg" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

emit_init_event() {
  local session_id="$1"
  printf '{"type":"system","subtype":"init","session_id":"%s","tools":[],"mcp_servers":[]}\n' "$session_id"
}

next_attempt() {
  local state_file="${CLAUDE_TEST_STATE_FILE:?CLAUDE_TEST_STATE_FILE is required}"
  local current=0
  if [ -f "$state_file" ]; then
    current="$(cat "$state_file")"
  fi
  current=$((current + 1))
  printf '%s' "$current" > "$state_file"
}

# Help probes
if contains_arg "--help" "$@"; then
  echo "usage: claude [-p] [--resume <session-id>] [--verbose] [--output-format <format>]"
  exit 0
fi

scenario="${CLAUDE_TEST_SCENARIO:-}"

# Resume run (--resume is present but --help is not)
if contains_arg "--resume" "$@"; then
  next_attempt
  case "$scenario" in
    resume_fail_then_fresh_fail)
      emit_init_event "${CLAUDE_RESUME_SESSION_ID:?CLAUDE_RESUME_SESSION_ID is required}"
      exit 17
      ;;
    resume_success_same_id)
      emit_init_event "${CLAUDE_RESUME_SESSION_ID:?CLAUDE_RESUME_SESSION_ID is required}"
      exit 0
      ;;
    resume_fail_fresh_success_new_id)
      emit_init_event "${CLAUDE_RESUME_SESSION_ID:?CLAUDE_RESUME_SESSION_ID is required}"
      exit 23
      ;;
    *)
      echo "unexpected resume scenario: ${scenario}" >&2
      exit 1
      ;;
  esac
fi

# Fresh run (no --resume)
if contains_arg "-p" "$@"; then
  next_attempt
  case "$scenario" in
    resume_fail_then_fresh_fail)
      echo '{"type":"system","subtype":"error"}'
      exit 19
      ;;
    resume_fail_fresh_success_new_id|fresh_success_new_id)
      emit_init_event "${CLAUDE_FRESH_SESSION_ID:?CLAUDE_FRESH_SESSION_ID is required}"
      exit 0
      ;;
    *)
      echo "unexpected fresh scenario: ${scenario}" >&2
      exit 1
      ;;
  esac
fi

echo "unexpected claude invocation: $*" >&2
exit 1
EOF

  chmod +x "${mock_bin}/gh" "${mock_bin}/codex" "${mock_bin}/claude" "${mock_bin}/mktemp"
}

setup_case_repo() {
  local repo_dir="$1"
  local bare_dir="${repo_dir}.bare"

  # Create a local bare repo as origin so fetch/reset/clean succeed
  # during the reuse-sync path in clone_repo().
  git init -q --bare "$bare_dir"
  git init -q -b main "$repo_dir"
  git -C "$repo_dir" config user.name "test"
  git -C "$repo_dir" config user.email "test@test"
  git -C "$repo_dir" remote add origin "$bare_dir"
  git -C "$repo_dir" commit --allow-empty -q -m "init"
  git -C "$repo_dir" push -q -u origin main
}

run_run_once() {
  local case_dir="$1"
  shift
  local repo_root="$1"
  shift

  env -u HIVEMOOT_BUZZ_ROLE \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    TARGET_REPO="owner/repo" \
    AGENT_IDENTITY="hivemoot-agent" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    AGENT_WORKLOAD="hivemoot" \
    WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    AGENT_PROVIDER="codex" \
    AGENT_AUTH_MODE="api_key" \
    OPENAI_API_KEY="test-openai-key" \
    AGENT_GITHUB_TOKEN="test-gh-token" \
    AGENT_PROMPT_FILE="${repo_root}/workloads/hivemoot/prompts/autonomous.md" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    REPO_DIR="${case_dir}/repo" \
    LOG_DIR="${case_dir}/logs" \
    GIT_CLONE_DEPTH="50" \
    AGENT_SESSION_KEY="mention-thread:test-thread" \
    SESSION_RESUME="1" \
    SESSION_RESUME_MAX_IDLE_HOURS="12" \
    SESSION_RESUME_MAX_AGE_HOURS="24" \
    AGENT_TOOL_OPTIONS_JSON="{}" \
    AGENT_TIMEOUT_SECONDS="30" \
    CODEX_TEST_STATE_FILE="${case_dir}/codex-attempts" \
    "$@" \
    bash "${repo_root}/scripts/run-once.sh"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Running session resume lifecycle checks"

session_key="$(build_scoped_session_key "mention-thread:test-thread" "owner/repo" "codex" "" "{}")"
old_session_id="11111111-1111-1111-1111-111111111111"
new_session_id="22222222-2222-2222-2222-222222222222"

# Case 1: Resume fails and fresh retry fails -> stale session record is not re-saved.
case1_dir="${tmpdir}/case1"
mkdir -p "${case1_dir}/home" "${case1_dir}/workspace/sessions/codex" "${case1_dir}/logs"
setup_mocks "${case1_dir}/mock-bin"
setup_case_repo "${case1_dir}/repo"
map_file_case1="${case1_dir}/workspace/sessions/codex/tool-session-map.tsv"
now_epoch="$(date +%s)"
case1_created="$((now_epoch - 900))"
case1_last_used="$((now_epoch - 120))"
printf '%s\t%s\t%s\t%s\n' "$session_key" "$old_session_id" "$case1_created" "$case1_last_used" > "$map_file_case1"
before_case1="$(cat "$map_file_case1")"

if run_run_once "$case1_dir" "$repo_root" \
  CODEX_TEST_SCENARIO="resume_fail_then_fresh_fail" \
  CODEX_RESUME_THREAD_ID="$old_session_id"; then
  fail "case1: expected run-once.sh to fail after resume+fresh failures"
fi

after_case1="$(cat "$map_file_case1")"
assert_eq "$before_case1" "$after_case1" "case1: session map changed despite final failure"
echo "PASS: case1 resume-fail + fresh-fail keeps existing record unchanged"

# Case 2: Resume succeeds with same session id -> created is preserved and last_used advances.
case2_dir="${tmpdir}/case2"
mkdir -p "${case2_dir}/home" "${case2_dir}/workspace/sessions/codex" "${case2_dir}/logs"
setup_mocks "${case2_dir}/mock-bin"
setup_case_repo "${case2_dir}/repo"
map_file_case2="${case2_dir}/workspace/sessions/codex/tool-session-map.tsv"
case2_now="$(date +%s)"
case2_created="$((case2_now - 1200))"
case2_last_used="$((case2_now - 300))"
printf '%s\t%s\t%s\t%s\n' "$session_key" "$old_session_id" "$case2_created" "$case2_last_used" > "$map_file_case2"

run_run_once "$case2_dir" "$repo_root" \
  CODEX_TEST_SCENARIO="resume_success_same_id" \
  CODEX_RESUME_THREAD_ID="$old_session_id" >/dev/null

record_case2="$(read_session_record "$map_file_case2" "$session_key")"
[ -n "$record_case2" ] || fail "case2: missing session record after successful resume"
IFS=$'\t' read -r case2_sid case2_created_after case2_last_used_after <<< "$record_case2"
assert_eq "$old_session_id" "$case2_sid" "case2: session id changed unexpectedly"
assert_eq "$case2_created" "$case2_created_after" "case2: created epoch was not preserved"
assert_gt "$case2_last_used_after" "$case2_last_used" "case2: last_used was not advanced"
echo "PASS: case2 successful resume preserves created and updates last_used"

# Case 3: Resume fails then fresh succeeds -> new session id is persisted.
case3_dir="${tmpdir}/case3"
mkdir -p "${case3_dir}/home" "${case3_dir}/workspace/sessions/codex" "${case3_dir}/logs"
setup_mocks "${case3_dir}/mock-bin"
setup_case_repo "${case3_dir}/repo"
map_file_case3="${case3_dir}/workspace/sessions/codex/tool-session-map.tsv"
case3_now="$(date +%s)"
case3_created="$((case3_now - 1500))"
case3_last_used="$((case3_now - 400))"
printf '%s\t%s\t%s\t%s\n' "$session_key" "$old_session_id" "$case3_created" "$case3_last_used" > "$map_file_case3"

run_run_once "$case3_dir" "$repo_root" \
  CODEX_TEST_SCENARIO="resume_fail_fresh_success_new_id" \
  CODEX_RESUME_THREAD_ID="$old_session_id" \
  CODEX_FRESH_THREAD_ID="$new_session_id" >/dev/null

record_case3="$(read_session_record "$map_file_case3" "$session_key")"
[ -n "$record_case3" ] || fail "case3: missing session record after fresh retry success"
IFS=$'\t' read -r case3_sid case3_created_after case3_last_used_after <<< "$record_case3"
assert_eq "$new_session_id" "$case3_sid" "case3: fresh session id was not stored"
assert_gt "$case3_created_after" "$case3_created" "case3: created epoch did not refresh for new session"
assert_ge "$case3_last_used_after" "$case3_created_after" "case3: last_used should be >= created"
echo "PASS: case3 resume-fail + fresh-success stores new session metadata"

echo "PASS: codex session resume lifecycle checks"

# ---------------------------------------------------------------------------
# Claude provider tests
# ---------------------------------------------------------------------------
echo "Running claude session resume lifecycle checks"

claude_session_key="$(build_scoped_session_key "mention-thread:test-thread" "owner/repo" "claude" "" "{}")"
claude_old_session_id="33333333-3333-3333-3333-333333333333"
claude_new_session_id="44444444-4444-4444-4444-444444444444"

run_run_once_claude() {
  local case_dir="$1"
  shift
  local repo_root="$1"
  shift

  env -u HIVEMOOT_BUZZ_ROLE \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    TARGET_REPO="owner/repo" \
    AGENT_IDENTITY="hivemoot-agent" \
    IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
    AGENT_WORKLOAD="hivemoot" \
    WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
    INTEGRATION_DIR="${repo_root}/integrations" \
    AGENT_PROVIDER="claude" \
    AGENT_AUTH_MODE="api_key" \
    ANTHROPIC_API_KEY="test-anthropic-key" \
    AGENT_GITHUB_TOKEN="test-gh-token" \
    AGENT_PROMPT_FILE="${repo_root}/workloads/hivemoot/prompts/autonomous.md" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    REPO_DIR="${case_dir}/repo" \
    LOG_DIR="${case_dir}/logs" \
    AGENT_SESSION_KEY="mention-thread:test-thread" \
    SESSION_RESUME="1" \
    SESSION_RESUME_MAX_IDLE_HOURS="12" \
    SESSION_RESUME_MAX_AGE_HOURS="24" \
    AGENT_TOOL_OPTIONS_JSON="{}" \
    AGENT_TIMEOUT_SECONDS="30" \
    CLAUDE_TEST_STATE_FILE="${case_dir}/claude-attempts" \
    "$@" \
    bash "${repo_root}/scripts/run-once.sh"
}

# Claude Case 1: Resume fails and fresh retry fails -> stale session record is not re-saved.
claude_case1_dir="${tmpdir}/claude-case1"
mkdir -p "${claude_case1_dir}/home" "${claude_case1_dir}/workspace/sessions/claude" "${claude_case1_dir}/logs"
setup_mocks "${claude_case1_dir}/mock-bin"
setup_case_repo "${claude_case1_dir}/repo"
claude_map_file_case1="${claude_case1_dir}/workspace/sessions/claude/tool-session-map.tsv"
claude_now_epoch="$(date +%s)"
claude_case1_created="$((claude_now_epoch - 900))"
claude_case1_last_used="$((claude_now_epoch - 120))"
printf '%s\t%s\t%s\t%s\n' "$claude_session_key" "$claude_old_session_id" "$claude_case1_created" "$claude_case1_last_used" > "$claude_map_file_case1"
claude_before_case1="$(cat "$claude_map_file_case1")"

if run_run_once_claude "$claude_case1_dir" "$repo_root" \
  CLAUDE_TEST_SCENARIO="resume_fail_then_fresh_fail" \
  CLAUDE_RESUME_SESSION_ID="$claude_old_session_id"; then
  fail "claude case1: expected run-once.sh to fail after resume+fresh failures"
fi

claude_after_case1="$(cat "$claude_map_file_case1")"
assert_eq "$claude_before_case1" "$claude_after_case1" "claude case1: session map changed despite final failure"
echo "PASS: claude case1 resume-fail + fresh-fail keeps existing record unchanged"

# Claude Case 2: Resume succeeds with same session id -> created is preserved and last_used advances.
claude_case2_dir="${tmpdir}/claude-case2"
mkdir -p "${claude_case2_dir}/home" "${claude_case2_dir}/workspace/sessions/claude" "${claude_case2_dir}/logs"
setup_mocks "${claude_case2_dir}/mock-bin"
setup_case_repo "${claude_case2_dir}/repo"
claude_map_file_case2="${claude_case2_dir}/workspace/sessions/claude/tool-session-map.tsv"
claude_case2_now="$(date +%s)"
claude_case2_created="$((claude_case2_now - 1200))"
claude_case2_last_used="$((claude_case2_now - 300))"
printf '%s\t%s\t%s\t%s\n' "$claude_session_key" "$claude_old_session_id" "$claude_case2_created" "$claude_case2_last_used" > "$claude_map_file_case2"

run_run_once_claude "$claude_case2_dir" "$repo_root" \
  CLAUDE_TEST_SCENARIO="resume_success_same_id" \
  CLAUDE_RESUME_SESSION_ID="$claude_old_session_id" >/dev/null

claude_record_case2="$(read_session_record "$claude_map_file_case2" "$claude_session_key")"
[ -n "$claude_record_case2" ] || fail "claude case2: missing session record after successful resume"
IFS=$'\t' read -r claude_case2_sid claude_case2_created_after claude_case2_last_used_after <<< "$claude_record_case2"
assert_eq "$claude_old_session_id" "$claude_case2_sid" "claude case2: session id changed unexpectedly"
assert_eq "$claude_case2_created" "$claude_case2_created_after" "claude case2: created epoch was not preserved"
assert_gt "$claude_case2_last_used_after" "$claude_case2_last_used" "claude case2: last_used was not advanced"
echo "PASS: claude case2 successful resume preserves created and updates last_used"

# Claude Case 3: Resume fails then fresh succeeds -> new session id is persisted.
claude_case3_dir="${tmpdir}/claude-case3"
mkdir -p "${claude_case3_dir}/home" "${claude_case3_dir}/workspace/sessions/claude" "${claude_case3_dir}/logs"
setup_mocks "${claude_case3_dir}/mock-bin"
setup_case_repo "${claude_case3_dir}/repo"
claude_map_file_case3="${claude_case3_dir}/workspace/sessions/claude/tool-session-map.tsv"
claude_case3_now="$(date +%s)"
claude_case3_created="$((claude_case3_now - 1500))"
claude_case3_last_used="$((claude_case3_now - 400))"
printf '%s\t%s\t%s\t%s\n' "$claude_session_key" "$claude_old_session_id" "$claude_case3_created" "$claude_case3_last_used" > "$claude_map_file_case3"

run_run_once_claude "$claude_case3_dir" "$repo_root" \
  CLAUDE_TEST_SCENARIO="resume_fail_fresh_success_new_id" \
  CLAUDE_RESUME_SESSION_ID="$claude_old_session_id" \
  CLAUDE_FRESH_SESSION_ID="$claude_new_session_id" >/dev/null

claude_record_case3="$(read_session_record "$claude_map_file_case3" "$claude_session_key")"
[ -n "$claude_record_case3" ] || fail "claude case3: missing session record after fresh retry success"
IFS=$'\t' read -r claude_case3_sid claude_case3_created_after claude_case3_last_used_after <<< "$claude_record_case3"
assert_eq "$claude_new_session_id" "$claude_case3_sid" "claude case3: fresh session id was not stored"
assert_gt "$claude_case3_created_after" "$claude_case3_created" "claude case3: created epoch did not refresh for new session"
assert_ge "$claude_case3_last_used_after" "$claude_case3_created_after" "claude case3: last_used should be >= created"
echo "PASS: claude case3 resume-fail + fresh-success stores new session metadata"

task_codex_session_key="$(build_scoped_session_key "task:task-followup" "owner/repo" "codex" "" "{}")"
task_claude_session_key="$(build_scoped_session_key "task:task-followup" "owner/repo" "claude" "" "{}")"

# Task-key Codex case: the normal resume lifecycle should work with task-scoped keys.
task_codex_dir="${tmpdir}/task-codex-case"
mkdir -p "${task_codex_dir}/home" "${task_codex_dir}/workspace/sessions/codex" "${task_codex_dir}/logs"
setup_mocks "${task_codex_dir}/mock-bin"
setup_case_repo "${task_codex_dir}/repo"
task_codex_map_file="${task_codex_dir}/workspace/sessions/codex/tool-session-map.tsv"
task_codex_now="$(date +%s)"
task_codex_created="$((task_codex_now - 600))"
task_codex_last_used="$((task_codex_now - 60))"
printf '%s\t%s\t%s\t%s\n' "$task_codex_session_key" "$old_session_id" "$task_codex_created" "$task_codex_last_used" > "$task_codex_map_file"

run_run_once "$task_codex_dir" "$repo_root" \
  AGENT_TASK_ID="task-followup" \
  AGENT_SESSION_KEY="task:task-followup" \
  CODEX_TEST_SCENARIO="resume_success_same_id" \
  CODEX_RESUME_THREAD_ID="$old_session_id" >/dev/null

task_codex_record="$(read_session_record "$task_codex_map_file" "$task_codex_session_key")"
[ -n "$task_codex_record" ] || fail "task codex: missing session record after successful resume"
IFS=$'\t' read -r task_codex_sid task_codex_created_after task_codex_last_used_after <<< "$task_codex_record"
assert_eq "$old_session_id" "$task_codex_sid" "task codex: session id changed unexpectedly"
assert_eq "$task_codex_created" "$task_codex_created_after" "task codex: created epoch was not preserved"
assert_gt "$task_codex_last_used_after" "$task_codex_last_used" "task codex: last_used was not advanced"
echo "PASS: task-key codex resume preserves session metadata"

# Task-key Claude case: task mode now keeps stream-json so Claude sessions are saved/resumed too.
task_claude_dir="${tmpdir}/task-claude-case"
mkdir -p "${task_claude_dir}/home" "${task_claude_dir}/workspace/sessions/claude" "${task_claude_dir}/logs"
setup_mocks "${task_claude_dir}/mock-bin"
setup_case_repo "${task_claude_dir}/repo"
task_claude_map_file="${task_claude_dir}/workspace/sessions/claude/tool-session-map.tsv"
task_claude_now="$(date +%s)"
task_claude_created="$((task_claude_now - 600))"
task_claude_last_used="$((task_claude_now - 60))"
printf '%s\t%s\t%s\t%s\n' "$task_claude_session_key" "$claude_old_session_id" "$task_claude_created" "$task_claude_last_used" > "$task_claude_map_file"

run_run_once_claude "$task_claude_dir" "$repo_root" \
  AGENT_TASK_ID="task-followup" \
  AGENT_SESSION_KEY="task:task-followup" \
  CLAUDE_TEST_SCENARIO="resume_success_same_id" \
  CLAUDE_RESUME_SESSION_ID="$claude_old_session_id" >/dev/null

task_claude_record="$(read_session_record "$task_claude_map_file" "$task_claude_session_key")"
[ -n "$task_claude_record" ] || fail "task claude: missing session record after successful resume"
IFS=$'\t' read -r task_claude_sid task_claude_created_after task_claude_last_used_after <<< "$task_claude_record"
assert_eq "$claude_old_session_id" "$task_claude_sid" "task claude: session id changed unexpectedly"
assert_eq "$task_claude_created" "$task_claude_created_after" "task claude: created epoch was not preserved"
assert_gt "$task_claude_last_used_after" "$task_claude_last_used" "task claude: last_used was not advanced"
echo "PASS: task-key claude resume preserves session metadata"

echo "PASS: all session resume lifecycle checks"
